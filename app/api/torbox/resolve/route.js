import { NextResponse } from 'next/server';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { findViaTorrentio } from '../../../../lib/torrentio';

const execFileAsync = promisify(execFile);
const YTS_DOMAINS = ['yts.am', 'yts.pm', 'yts.do', 'yts.rs'];

// Hard cap: never pick (or add to the account) a file larger than this.
const MAX_GB = 10;
const MAX_BYTES = MAX_GB * 1024 * 1024 * 1024;
const withinCap = (bytes) => !bytes || Number(bytes) <= MAX_BYTES;

// Always hand the browser an HLS stream from TorBox's transcoder (H.264 + AAC),
// never a raw MKV/HEVC file, so playback behaves the same everywhere.
const FORCE_HLS = true;

const VIDEO_EXT = /\.(mkv|mp4|m4v|avi|webm|mov)$/i;
const normName = (s) =>
  String(s || '').toLowerCase().replace(/['’]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const baseName = (path) => String(path || '').split('/').pop();

function qualityOf(name) {
  if (/2160p|4k|uhd/i.test(name)) return '2160p';
  if (/1080p/i.test(name)) return '1080p';
  if (/720p/i.test(name)) return '720p';
  return '';
}

// Look through the viewer's own TorBox library for a finished video file that matches the
// title (movie: title + year, series: title + SxxExx). The size cap applies to the FILE, so a
// small episode/movie inside a big pack still qualifies. Returns { torrentId, file, quality } or null.
async function findInLibrary({ token, title, year, isTv, season, episode }) {
  try {
    // bypass_cache: the list is otherwise up to 600 s stale, so something just added in Stremio could be missed.
    const res = await fetch('https://api.torbox.app/v1/api/torrents/mylist?bypass_cache=true', {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const list = (await res.json())?.data;
    if (!Array.isArray(list)) return null;

    const wanted = ` ${normName(title)} `;
    const sNum = Number(season) || 1;
    const eNum = Number(episode) || 1;
    const epRe = isTv ? new RegExp(`(?:\\bs0*${sNum}e0*${eNum}\\b|\\b${sNum}x0*${eNum}\\b)`, 'i') : null;
    const yearStr = year ? String(year) : '';
    const rank = { '1080p': 3, '720p': 2, '2160p': 1, '': 0 };

    let best = null;
    for (const t of list) {
      if (!t || !Array.isArray(t.files)) continue;
      if (!(t.download_finished || t.cached)) continue; // skip stalled / unfinished
      const torrentTitleOk = ` ${normName(t.name)} `.includes(wanted);
      for (const f of t.files) {
        const base = baseName(f.name);
        if (!VIDEO_EXT.test(base) || /\bsample\b/i.test(f.name)) continue;
        if (!withinCap(f.size) || Number(f.size) < 50 * 1024 * 1024) continue;
        const nameOk = ` ${normName(base)} `.includes(wanted);
        if (isTv) {
          if (!epRe.test(base)) continue;
          if (!nameOk && !torrentTitleOk) continue;
        } else {
          if (!nameOk) continue;
          if (yearStr && !base.includes(yearStr)) continue;
        }
        const quality = qualityOf(base) || qualityOf(t.name || '');
        const cand = { torrentId: t.id, file: { id: f.id, name: f.name, size: f.size }, quality, score: rank[quality] ?? 0 };
        if (!best || cand.score > best.score || (cand.score === best.score && cand.file.size > best.file.size)) best = cand;
      }
    }
    return best;
  } catch {
    return null;
  }
}

// TorBox resolution indexes: 0=144p 1=240p 2=360p 3=480p 4=720p 5=1080p 6=1440p 7=2160p, null=original.
// TorBox never upscales, so asking for 1080p on a 720p file just plays 720p.
const DEFAULT_RES = 5; // 1080p keeps the stream around 5-8 Mbps instead of ~13+ for 4K
function parseRes(v) {
  if (v === null || v === 'null' || v === 'original') return 'null';
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 && n <= 7 ? String(n) : String(DEFAULT_RES);
}

// Preferred audio language. Multi-audio releases (e.g. Tam+Hin+Tel+Eng) put one language first, so
// asking for track 0 plays whatever that is. We read the file's audio list and pick the right track.
// Values are ISO 639-2 codes as TorBox reports them ("eng", "hin", "tam", "tel", "mal", "kan").
const LANG_NAMES = { eng: 'english', hin: 'hindi', tam: 'tamil', tel: 'telugu', mal: 'malayalam', kan: 'kannada' };
function parseAudioLang(v) {
  const s = String(v || '').toLowerCase();
  return LANG_NAMES[s] ? s : ''; // '' = no preference, keep the first track
}
function audioMatches(a, lang) {
  const code = String(a?.language || '').toLowerCase();
  const full = String(a?.language_full || '').toLowerCase();
  return code === lang || code.startsWith(lang.slice(0, 2)) || full.includes(LANG_NAMES[lang]) || String(a?.title || '').toLowerCase().includes(LANG_NAMES[lang]);
}

async function createStreamCall(token, torrentId, fileId, resIdx, audioIdx) {
  const res = await fetch(
    `https://api.torbox.app/v1/api/stream/createstream?id=${torrentId}&file_id=${fileId}&type=torrent&chosen_subtitle_index=null&chosen_audio_index=${audioIdx}&chosen_resolution_index=${resIdx}`,
    { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(12000) }
  );
  if (!res.ok) return null;
  return (await res.json())?.data || null;
}

// The file's audio tracks as [{ pos, code, label, channels }]; pos is the position TorBox wants back.
function audioListFrom(info) {
  return (info?.metadata?.audios || []).map((a, pos) => ({
    pos,
    code: String(a.language || '').toLowerCase(),
    label: a.language_full || a.language || `Track ${pos + 1}`,
    channels: a.channel_layout || '',
  }));
}

async function createHls(token, torrentId, fileId, resIdx = String(DEFAULT_RES), audioLang = '', audioPos = null) {
  try {
    // An explicit audio position (from the player's Audio menu) wins over the language preference.
    if (audioPos !== null) {
      const picked = await createStreamCall(token, torrentId, fileId, resIdx, audioPos);
      return picked?.hls_url || null;
    }
    let data = await createStreamCall(token, torrentId, fileId, resIdx, 0);
    if (!data) return null;
    // The first call lists the audio tracks; if the preferred language isn't track 0, ask again for it.
    // TorBox wants the position in the list (0,1,2...), not the track's own "index" value.
    const audios = data.metadata?.audios;
    if (audioLang && Array.isArray(audios) && audios.length > 1) {
      const pos = audios.findIndex((a) => audioMatches(a, audioLang));
      if (pos > 0) {
        const picked = await createStreamCall(token, torrentId, fileId, resIdx, pos);
        if (picked?.hls_url) data = picked;
      }
    }
    return data.hls_url || null;
  } catch {
    return null;
  }
}

async function fetchTmdbMeta(tmdbId, isTv) {
  const key = process.env.TMDB_API_KEY;
  if (!key) return null;
  try {
    const kind = isTv ? 'tv' : 'movie';
    const res = await fetch(
      `https://api.themoviedb.org/3/${kind}/${encodeURIComponent(tmdbId)}?api_key=${key}${isTv ? '&append_to_response=external_ids' : ''}`,
      { signal: AbortSignal.timeout(4000) }
    );
    if (!res.ok) return null;
    const j = await res.json();
    const date = (isTv ? j.first_air_date : j.release_date) || '';
    return {
      title: isTv ? j.name : j.title,
      year: date ? date.slice(0, 4) : undefined,
      imdbId: isTv ? j.external_ids?.imdb_id : j.imdb_id,
    };
  } catch {
    return null;
  }
}

// The IMDb id Torrentio needs. Callers usually only have the TMDB id.
async function lookupImdbId(tmdbId, isTv) {
  if (!tmdbId) return null;
  try {
    const key = process.env.TMDB_API_KEY || 'baf435afe9fef24b14b2a137359e4124';
    const res = await fetch(`https://api.themoviedb.org/3/${isTv ? 'tv' : 'movie'}/${encodeURIComponent(tmdbId)}/external_ids?api_key=${key}`, {
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return null;
    return (await res.json())?.imdb_id || null;
  } catch {
    return null;
  }
}

async function searchYts(query, imdbId) {
  for (const domain of YTS_DOMAINS) {
    try {
      const searchTerm = imdbId || query;
      const res = await fetch(`https://${domain}/api/v2/list_movies.json?query_term=${encodeURIComponent(searchTerm)}`, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(4000),
      });
      if (!res.ok) continue;
      const json = await res.json();
      if (json.data?.movies?.length > 0) {
        return json.data.movies[0];
      }
    } catch {}
  }
  return null;
}

async function searchPirateBay(query) {
  try {
    const url = `https://apibay.org/q.php?q=${encodeURIComponent(query)}`;
    const { stdout } = await execFileAsync(
      'curl',
      [
        '-s',
        '-H',
        'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        url,
      ],
      { timeout: 6000 }
    );
    const json = JSON.parse(stdout);
    return Array.isArray(json) ? json.filter((t) => t.info_hash && t.info_hash !== '0000000000000000000000000000000000000000') : [];
  } catch (err) {
    console.warn('PirateBay search error:', err.message);
    return [];
  }
}

function cleanShowName(str) {
  return (str || '')
    .toLowerCase()
    .replace(/^\[[^\]]+\]\s*/, '') // remove leading bracket tags like [HorribleSubs] or [Force-Works]
    .replace(/\([^\)]+\)/g, ' ')   // remove parenthesis content
    .replace(/[\._\-:,]/g, ' ')     // replace separators with space
    .replace(/\s+/g, ' ')
    .trim();
}

function matchesShowTitle(torrentName, candidateTitles) {
  if (!torrentName) return false;

  const rawName = torrentName.replace(/^\[[^\]]+\]\s*/, '');
  const normTorrent = rawName.toLowerCase().replace(/[\._\-:,]/g, ' ').replace(/\s+/g, ' ').trim();

  // Find where the season / episode / year specifier starts
  const markerRegex = /\b(?:s\d{1,2}(?:e\d{1,2})?|season\s*\d{1,2}|\d{1,2}x\d{1,2}|ep(?:isode)?\s*\d{1,2}|(?:19|20)\d{2})\b/i;
  const match = normTorrent.match(markerRegex);
  const prefix = match ? normTorrent.slice(0, match.index).trim() : normTorrent;

  for (const rawCandidate of candidateTitles) {
    if (!rawCandidate) continue;
    const cleanCand = cleanShowName(rawCandidate);
    if (!cleanCand) continue;

    // 1. If prefix matches candidate exactly
    if (prefix === cleanCand) return true;

    // 2. If prefix is "iron man anime" and candidate is "iron man"
    if (prefix.startsWith(cleanCand)) {
      const remainder = prefix.slice(cleanCand.length).trim();
      if (!remainder || /^(?:anime|tv|series|us|uk|japan)$/i.test(remainder)) {
        return true;
      }
    }

    // 3. Handle optional leading "the "
    const noThePrefix = prefix.replace(/^the\s+/, '');
    const noTheCand = cleanCand.replace(/^the\s+/, '');
    if (noThePrefix && noThePrefix === noTheCand) return true;
  }

  return false;
}

/**
 * Checks whether a video file in a torrent can be played natively across all browsers
 * (Chrome, Safari, Firefox, Edge, iOS, Android) via standard HTML5 video byte-range requests
 * without requiring live server-side transcoding.
 */
function isUniversalWebVideo(fileName) {
  if (!fileName) return false;
  const lower = fileName.toLowerCase();
  const isMp4 = lower.endsWith('.mp4') || lower.endsWith('.m4v');
  if (!isMp4) return false; // MKV, AVI, etc. cannot be played natively in all browsers
  // If filename indicates heavy/incompatible codecs that basic browsers choke on:
  const incompatible = /hevc|x265|h\.?265|10bit|10-bit|hdr|dts|truehd|atmos|ac3|eac3|av1/i;
  if (incompatible.test(lower)) return false;
  return true;
}

export async function POST(req) {
  try {
    let { title, year, imdbId, tmdbId, mediaType, season, episode, dryRun, resolutionIndex, audioLang: audioLangRaw, audioIndex, listAudios, torrentId: torrentIdIn, fileId: fileIdIn } = await req.json();
    const resIdx = parseRes(resolutionIndex);
    const audioLang = parseAudioLang(audioLangRaw);
    // Position in the file's audio list (0,1,2...), or null when the caller has no explicit pick.
    const audioPos = audioIndex !== null && audioIndex !== undefined && audioIndex !== '' && Number.isInteger(Number(audioIndex)) && Number(audioIndex) >= 0
      ? Number(audioIndex)
      : null;
    // The key is the viewer's own, saved in their browser and sent per request.
    const token = (req.headers.get('x-torbox-key') || '').trim();

    if (!token) {
      return NextResponse.json({ success: false, error: 'TorBox API key not set' }, { status: 401 });
    }

    // Direct mode: the caller already knows the exact TorBox file (the Audio menu does). No title
    // search, no library lookup: just list that file's audio tracks or make a stream with one of them.
    const directTid = Number(torrentIdIn);
    const directFid = Number(fileIdIn);
    if (torrentIdIn != null && fileIdIn != null && Number.isInteger(directTid) && directTid > 0 && Number.isInteger(directFid) && directFid >= 0) {
      if (listAudios) {
        const info = await createStreamCall(token, directTid, directFid, resIdx, 0).catch(() => null);
        return NextResponse.json(info ? { success: true, audios: audioListFrom(info) } : { success: false, reason: 'Could not read audio tracks' });
      }
      const directHls = await createHls(token, directTid, directFid, resIdx, audioLang, audioPos);
      if (!directHls) return NextResponse.json({ success: false, reason: 'Could not create the stream' });
      return NextResponse.json({
        success: true,
        cached: true,
        torrentId: directTid,
        fileId: directFid,
        streamType: 'hls',
        streamUrl: directHls,
        hlsUrl: directHls,
        directUrl: null,
        canDirect: false,
      });
    }

    const isTv = mediaType === 'tv' || (season !== undefined && episode !== undefined);

    // Callers usually only know the TMDB id, so look up the title/year/imdb id here.
    if (tmdbId && !title) {
      const meta = await fetchTmdbMeta(tmdbId, isTv);
      if (meta) {
        title = meta.title;
        year = year || meta.year;
        imdbId = imdbId || meta.imdbId;
      }
    }
    if (!title) {
      return NextResponse.json({ success: false, cached: false, reason: 'Missing title' });
    }

    // 1) Your own TorBox library first: no torrent-site search, instant if it's already there.
    const own = await findInLibrary({ token, title, year, isTv, season, episode });
    if (own) {
      const label = isTv ? `${title} S${String(Number(season) || 1).padStart(2, '0')}:E${String(Number(episode) || 1).padStart(2, '0')}` : title;
      if (dryRun) {
        return NextResponse.json({ success: true, dryRun: true, source: 'library', torrentId: own.torrentId, file: own.file, quality: own.quality || null, title: label });
      }
      if (listAudios) {
        // For the player's Audio menu: the audio tracks in this file, in the order TorBox wants them.
        try {
          const info = await createStreamCall(token, own.torrentId, own.file.id, resIdx, 0);
          return NextResponse.json({ success: true, audios: audioListFrom(info) });
        } catch {
          return NextResponse.json({ success: false, reason: 'Could not read audio tracks' });
        }
      }
      const ownHls = await createHls(token, own.torrentId, own.file.id, resIdx, audioLang, audioPos);
      if (ownHls) {
        return NextResponse.json({
          success: true,
          cached: true,
          source: 'library',
          torrentId: own.torrentId,
          fileId: own.file.id,
          streamType: 'hls',
          streamUrl: ownHls,
          directUrl: null,
          hlsUrl: ownHls,
          canDirect: false,
          quality: own.quality || '1080p',
          fileSize: own.file.size,
          fileName: own.file.name,
          title: label,
        });
      }
    }
    if (listAudios) {
      return NextResponse.json({ success: false, reason: 'This title is not in your TorBox library' });
    }
    if (dryRun) {
      return NextResponse.json({ success: false, dryRun: true, reason: `Not in your TorBox library under ${MAX_GB} GB (a Torrentio search would follow)` });
    }

    // 2) Torrentio: ~15 trackers by IMDb id (movie or exact episode), cache-checked against the viewer's TorBox.
    //    Falls through to the older YTS / PirateBay search below if Torrentio finds nothing playable.
    const imdbForSearch = imdbId || (await lookupImdbId(tmdbId, isTv));
    if (imdbForSearch) {
      const tio = await findViaTorrentio({
        token,
        imdbId: imdbForSearch,
        isTv,
        season,
        episode,
        maxBytes: MAX_BYTES,
        createHls: (torrentId, fileId) => createHls(token, torrentId, fileId, resIdx, audioLang, audioPos),
      }).catch((e) => ({ ok: false, reason: String(e?.message || e) }));

      if (tio.ok && tio.hls) {
        const label = isTv ? `${title} S${String(Number(season) || 1).padStart(2, '0')}:E${String(Number(episode) || 1).padStart(2, '0')}` : title;
        return NextResponse.json({
          success: true,
          cached: true,
          source: 'torrentio',
          torrentId: tio.torrentId,
          fileId: tio.file.id,
          streamType: 'hls',
          streamUrl: tio.hls,
          directUrl: null,
          hlsUrl: tio.hls,
          canDirect: false,
          quality: tio.candidate.res || '1080p',
          fileSize: tio.file.size,
          fileName: tio.file.name,
          title: label,
        });
      }
      console.warn(`[torbox] Torrentio found nothing playable for ${imdbForSearch}: ${tio.reason || 'unknown'}; trying the older search`);
    }

    // 3) Older search (YTS for movies, PirateBay for series) + TorBox cache check below.

    // ──────────────────────────────────────────
    // TV SERIES RESOLVER
    // ──────────────────────────────────────────
    if (isTv) {
      const sNum = Number(season) || 1;
      const eNum = Number(episode) || 1;
      const sStr = String(sNum).padStart(2, '0');
      const eStr = String(eNum).padStart(2, '0');

      // Candidate search titles (include alternative titles / native names like Nan Hong)
      const candidateTitles = [title];
      if (year) {
        candidateTitles.push(`${title} ${year}`);
        candidateTitles.push(`${title} (${year})`);
      }

      if (tmdbId) {
        try {
          const tmdbApiKey = process.env.TMDB_API_KEY || 'baf435afe9fef24b14b2a137359e4124';
          const altRes = await fetch(`https://api.themoviedb.org/3/tv/${tmdbId}/alternative_titles?api_key=${tmdbApiKey}`, {
            signal: AbortSignal.timeout(3000),
          });
          if (altRes.ok) {
            const altJson = await altRes.json();
            const results = altJson.results || [];
            results.forEach((r) => {
              if (r.title && !candidateTitles.includes(r.title)) candidateTitles.push(r.title);
            });
          }
        } catch {}
      }

      // Search PirateBay prioritizing exact episode & season packs in parallel
      const queries = [];
      if (year) {
        queries.push(`${title} ${year} S${sStr}E${eStr}`);
        queries.push(`${title} ${year}`);
      }
      candidateTitles.forEach((t) => {
        queries.push(`${t} S${sStr}E${eStr}`);
        queries.push(`${t} S${sStr}`);
        queries.push(`${t} Season ${sNum}`);
        queries.push(t);
      });

      const uniqueQueries = [...new Set(queries)].slice(0, 5);
      const searchResults = await Promise.all(uniqueQueries.map((q) => searchPirateBay(q)));
      const pbTorrents = [];
      const seenHashes = new Set();
      for (const list of searchResults) {
        if (Array.isArray(list)) {
          for (const t of list) {
            const h = (t.info_hash || '').toLowerCase();
            if (h && !seenHashes.has(h)) {
              seenHashes.add(h);
              pbTorrents.push(t);
            }
          }
        }
      }

      if (pbTorrents.length === 0) {
        return NextResponse.json({ success: false, cached: false, reason: 'No torrents found for series' });
      }

      const hashes = pbTorrents.slice(0, 30).map((t) => t.info_hash.toLowerCase());

      // Batch check TorBox cache
      // list_files=true: we get each cached torrent's files + sizes before adding anything,
      // so a big season pack still qualifies when the episode file inside is under the cap.
      const cacheRes = await fetch('https://api.torbox.app/v1/api/torrents/checkcached?format=list&list_files=true', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ hashes }),
        signal: AbortSignal.timeout(8000),
      });

      if (!cacheRes.ok) {
        return NextResponse.json({ success: false, cached: false, reason: 'TorBox cache check failed' });
      }

      const cacheJson = await cacheRes.json();
      const cachedList = Array.isArray(cacheJson.data) ? cacheJson.data : [];
      if (cachedList.length === 0) {
        return NextResponse.json({ success: false, cached: false, reason: 'No cached torrent found on TorBox' });
      }

      const epRegex = new RegExp(`(?:s${sStr}e${eStr}|${sNum}x${eStr}|episode\\s*0?${eNum}\\b)`, 'i');
      const seasonRegex = new RegExp(`(?:s${sStr}\\b|season\\s*0?${sNum}\\b)`, 'i');

      // The size cap is per file: either the whole torrent is small, or it lists an episode file that is.
      const hasFittingEpisodeFile = (c) =>
        Array.isArray(c.files) &&
        c.files.some((f) => VIDEO_EXT.test(f.name || '') && !/\bsample\b/i.test(f.name) && epRegex.test(baseName(f.name)) && withinCap(f.size));
      const fitsCap = (c) => withinCap(c.size) || hasFittingEpisodeFile(c);

      // Filter cached torrents strictly matching the show title first
      const validCached = cachedList.filter((c) => matchesShowTitle(c.name || '', candidateTitles) && fitsCap(c));
      if (validCached.length === 0) {
        return NextResponse.json({ success: false, cached: false, reason: `No cached copy of S${sStr}E${eStr} with a file under ${MAX_GB} GB` });
      }

      // Prioritize x264/h264 over heavy x265/hevc so TorBox's live transcoder never chokes with 504 timeouts
      const scoreCodec = (name) => {
        const lower = (name || '').toLowerCase();
        if (/hevc|x265|h\.?265|10bit/i.test(lower)) return 1;
        if (/x264|h\.?264|avc/i.test(lower)) return 3;
        return 2;
      };
      const sortedCandidates = [...validCached].sort((a, b) => scoreCodec(b.name) - scoreCodec(a.name));

      // 1. Look for exact episode torrent (e.g. S01E02)
      let targetTorrent = sortedCandidates.find((c) => epRegex.test(c.name || ''));

      // 2. Or complete season pack (e.g. S01 Complete)
      if (!targetTorrent) {
        targetTorrent = sortedCandidates.find((c) => seasonRegex.test(c.name || '') && !/s\d+e\d+/i.test(c.name || ''));
      }

      // 3. Or any pack (e.g. "Complete Series") whose file list contains this episode under the cap
      if (!targetTorrent) {
        targetTorrent = sortedCandidates.find(hasFittingEpisodeFile);
      }

      // Strictly fail if neither exists so we NEVER play a wrong episode
      if (!targetTorrent) {
        return NextResponse.json({ success: false, cached: false, reason: `Episode S${sStr}E${eStr} not cached on TorBox` });
      }

      const targetHash = targetTorrent.hash.toLowerCase();

      // Add to TorBox
      const form = new FormData();
      form.append('magnet', `magnet:?xt=urn:btih:${targetHash}`);
      form.append('add_only_if_cached', 'true');

      const addRes = await fetch('https://api.torbox.app/v1/api/torrents/createtorrent', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: form,
        signal: AbortSignal.timeout(6000),
      });

      if (!addRes.ok) {
        return NextResponse.json({ success: false, cached: false, reason: 'Failed to add torrent to TorBox' });
      }

      const addJson = await addRes.json();
      const torrentId = addJson.data?.torrent_id;
      if (!torrentId) {
        return NextResponse.json({ success: false, cached: false, reason: 'Torrent ID not returned by TorBox' });
      }

      // Fetch files list
      const listRes = await fetch(`https://api.torbox.app/v1/api/torrents/mylist?id=${torrentId}`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(5000),
      });

      if (!listRes.ok) {
        return NextResponse.json({ success: false, cached: false, reason: 'Failed to fetch files list' });
      }

      const listJson = await listRes.json();
      const files = listJson.data?.files || [];

      // Filter out non-video files first (skip screenshots, nfo, sample, cover.jpg)
      const videoFiles = files.filter((f) => /\.(mp4|mkv|m4v|avi|webm|mov)$/i.test(f.name) && !/\/screenshots\//i.test(f.name) && !/\bsample\b/i.test(f.name));
      const epFile = videoFiles.find((f) => epRegex.test(f.name)) || files.find((f) => epRegex.test(f.name));

      if (!epFile) {
        return NextResponse.json({ success: false, cached: false, reason: `Episode S${sStr}E${eStr} file not found in torrent` });
      }

      if (!withinCap(epFile.size)) {
        return NextResponse.json({ success: false, cached: false, reason: `Episode file is larger than ${MAX_GB} GB` });
      }

      const canDirect = !FORCE_HLS && isUniversalWebVideo(epFile.name);
      let directUrl = null;
      let hlsUrl = null;

      if (canDirect) {
        // Universal web video (standard MP4): fast direct CDN pipe
        try {
          const dlRes = await fetch(
            `https://api.torbox.app/v1/api/torrents/requestdl?token=${token}&torrent_id=${torrentId}&file_id=${epFile.id}&redirect=false`,
            { signal: AbortSignal.timeout(6000) }
          );
          if (dlRes.ok) {
            directUrl = (await dlRes.json())?.data || null;
          }
        } catch {}
      } else {
        // MKV / HEVC: Requires TorBox HLS live transcoding
        hlsUrl = await createHls(token, torrentId, epFile.id, resIdx, audioLang, audioPos);
      }

      if (canDirect && directUrl) {
        return NextResponse.json({
          success: true,
          cached: true,
          streamType: 'direct',
          streamUrl: directUrl,
          directUrl,
          hlsUrl: null,
          canDirect: true,
          title: `${title} S${sStr}:E${eStr}`,
          fileName: epFile.name,
          quality: '1080p',
        });
      }

      if (hlsUrl) {
        return NextResponse.json({
          success: true,
          cached: true,
          torrentId,
          fileId: epFile.id,
          streamType: 'hls',
          streamUrl: hlsUrl,
          directUrl: null,
          hlsUrl,
          canDirect: false,
          title: `${title} S${sStr}:E${eStr}`,
          fileName: epFile.name,
          quality: '1080p',
        });
      }

      return NextResponse.json({
        success: false,
        cached: false,
        reason: 'Live HLS transcode unavailable for this MKV release',
      });
    }

    // ──────────────────────────────────────────
    // MOVIE RESOLVER
    // ──────────────────────────────────────────
    let resolvedImdb = imdbId;
    if (!resolvedImdb && tmdbId) {
      try {
        const tmdbApiKey = process.env.TMDB_API_KEY || 'baf435afe9fef24b14b2a137359e4124';
        const tmdbRes = await fetch(`https://api.themoviedb.org/3/movie/${tmdbId}/external_ids?api_key=${tmdbApiKey}`, {
          signal: AbortSignal.timeout(3000),
        });
        if (tmdbRes.ok) {
          const ids = await tmdbRes.json();
          if (ids.imdb_id) resolvedImdb = ids.imdb_id;
        }
      } catch {}
    }

    const movie = await searchYts(title, resolvedImdb);
    const allTorrents = movie?.torrents || [];
    const torrents = allTorrents.filter((t) => withinCap(t.size_bytes));
    if (torrents.length === 0) {
      return NextResponse.json({
        success: false,
        cached: false,
        reason: allTorrents.length ? `Every release is larger than ${MAX_GB} GB` : 'No torrent candidates found',
      });
    }

    const sortedTorrents = [...torrents].sort((a, b) => {
      const qScore = (q) => (q === '1080p' ? 3 : q === '720p' ? 2 : q === '2160p' ? 1 : 0);
      return qScore(b.quality) - qScore(a.quality);
    });

    const hashes = sortedTorrents.map((t) => t.hash.toLowerCase());

    const cacheRes = await fetch('https://api.torbox.app/v1/api/torrents/checkcached?format=list', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ hashes }),
      signal: AbortSignal.timeout(5000),
    });

    if (!cacheRes.ok) {
      return NextResponse.json({ success: false, cached: false, reason: 'TorBox cache check failed' });
    }

    const cacheJson = await cacheRes.json();
    const cachedList = (Array.isArray(cacheJson.data) ? cacheJson.data : []).filter((c) => withinCap(c.size));
    if (cachedList.length === 0) {
      return NextResponse.json({ success: false, cached: false, reason: `No cached stream under ${MAX_GB} GB available on TorBox` });
    }

    const cachedHashes = new Set(cachedList.map((c) => c.hash.toLowerCase()));
    const bestTorrent = sortedTorrents.find((t) => cachedHashes.has(t.hash.toLowerCase())) || sortedTorrents[0];
    const targetHash = bestTorrent.hash.toLowerCase();

    const form = new FormData();
    form.append('magnet', `magnet:?xt=urn:btih:${targetHash}`);
    form.append('add_only_if_cached', 'true');

    const addRes = await fetch('https://api.torbox.app/v1/api/torrents/createtorrent', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: form,
      signal: AbortSignal.timeout(6000),
    });

    if (!addRes.ok) {
      return NextResponse.json({ success: false, cached: false, reason: 'Failed to create torrent on TorBox' });
    }

    const addJson = await addRes.json();
    const torrentId = addJson.data?.torrent_id;
    if (!torrentId) {
      return NextResponse.json({ success: false, cached: false, reason: 'Torrent ID not returned by TorBox' });
    }

    const listRes = await fetch(`https://api.torbox.app/v1/api/torrents/mylist?id=${torrentId}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5000),
    });

    if (!listRes.ok) {
      return NextResponse.json({ success: false, cached: false, reason: 'Failed to fetch torrent files list' });
    }

    const listJson = await listRes.json();
    const files = listJson.data?.files || [];
    const videoFile = files.find((f) => f.name.endsWith('.mp4') || f.name.endsWith('.mkv')) || files[0];

    if (!videoFile) {
      return NextResponse.json({ success: false, cached: false, reason: 'No video file found in torrent' });
    }

    if (!withinCap(videoFile.size)) {
      return NextResponse.json({ success: false, cached: false, reason: `Video file is larger than ${MAX_GB} GB` });
    }

    const canDirect = !FORCE_HLS && isUniversalWebVideo(videoFile.name);
    let directUrl = null;
    let hlsUrl = null;

    if (canDirect) {
      try {
        const dlRes = await fetch(
          `https://api.torbox.app/v1/api/torrents/requestdl?token=${token}&torrent_id=${torrentId}&file_id=${videoFile.id}&redirect=false`,
          { signal: AbortSignal.timeout(6000) }
        );
        if (dlRes.ok) {
          directUrl = (await dlRes.json())?.data || null;
        }
      } catch {}
    } else {
      hlsUrl = await createHls(token, torrentId, videoFile.id, resIdx, audioLang, audioPos);
    }

    if (canDirect && directUrl) {
      return NextResponse.json({
        success: true,
        cached: true,
        streamType: 'direct',
        streamUrl: directUrl,
        directUrl,
        hlsUrl: null,
        canDirect: true,
        quality: bestTorrent.quality || '1080p',
        fileSize: videoFile.size,
        fileName: videoFile.name,
        title: movie?.title || title,
      });
    }

    if (hlsUrl) {
      return NextResponse.json({
        success: true,
        cached: true,
        torrentId,
        fileId: videoFile.id,
        streamType: 'hls',
        streamUrl: hlsUrl,
        directUrl: null,
        hlsUrl,
        canDirect: false,
        quality: bestTorrent.quality || '1080p',
        fileSize: videoFile.size,
        fileName: videoFile.name,
        title: movie?.title || title,
      });
    }

    return NextResponse.json({
      success: false,
      cached: false,
      reason: 'Could not generate stream for this movie release',
    });
  } catch (err) {
    console.error('TorBox resolve error:', err);
    return NextResponse.json({ success: false, cached: false, error: err.message }, { status: 500 });
  }
}
