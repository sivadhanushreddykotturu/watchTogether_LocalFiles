import { NextResponse } from 'next/server';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
const YTS_DOMAINS = ['yts.am', 'yts.pm', 'yts.do', 'yts.rs'];

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
  const markerRegex = /\b(?:s\d{1,2}|season\s*\d{1,2}|\d{1,2}x\d{1,2}|(?:19|20)\d{2})\b/i;
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
    const { title, year, imdbId, tmdbId, mediaType, season, episode } = await req.json();
    const token = process.env.TORBOX_API_KEY;

    if (!token) {
      return NextResponse.json({ success: false, error: 'TORBOX_API_KEY not configured' }, { status: 500 });
    }

    const isTv = mediaType === 'tv' || (season !== undefined && episode !== undefined);

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
      const cachedList = Array.isArray(cacheJson.data) ? cacheJson.data : [];
      if (cachedList.length === 0) {
        return NextResponse.json({ success: false, cached: false, reason: 'No cached torrent found on TorBox' });
      }

      const epRegex = new RegExp(`(?:s${sStr}e${eStr}|${sNum}x${eStr}|episode\\s*0?${eNum}\\b)`, 'i');
      const seasonRegex = new RegExp(`(?:s${sStr}\\b|season\\s*0?${sNum}\\b)`, 'i');

      // Filter cached torrents strictly matching the show title first
      const validCached = cachedList.filter((c) => matchesShowTitle(c.name || '', candidateTitles));

      // 1. Look for exact episode torrent (e.g. S01E02)
      let targetTorrent = validCached.find((c) => epRegex.test(c.name || ''));

      // 2. Or complete season pack (e.g. S01 Complete)
      if (!targetTorrent) {
        targetTorrent = validCached.find((c) => seasonRegex.test(c.name || '') && !/s\d+e\d+/i.test(c.name || ''));
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

      const canDirect = isUniversalWebVideo(epFile.name);
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
        try {
          const hlsRes = await fetch(
            `https://api.torbox.app/v1/api/stream/createstream?id=${torrentId}&file_id=${epFile.id}&type=torrent&chosen_subtitle_index=null&chosen_audio_index=0&chosen_resolution_index=null`,
            {
              headers: { Authorization: `Bearer ${token}` },
              signal: AbortSignal.timeout(12000),
            }
          );
          if (hlsRes.ok) {
            const hlsData = await hlsRes.json();
            hlsUrl = hlsData?.data?.hls_url || null;
          }
        } catch {}
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
    const torrents = movie?.torrents || [];
    if (torrents.length === 0) {
      return NextResponse.json({ success: false, cached: false, reason: 'No torrent candidates found' });
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
    const cachedList = Array.isArray(cacheJson.data) ? cacheJson.data : [];
    if (cachedList.length === 0) {
      return NextResponse.json({ success: false, cached: false, reason: 'No cached stream available on TorBox' });
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

    const canDirect = isUniversalWebVideo(videoFile.name);
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
      try {
        const hlsRes = await fetch(
          `https://api.torbox.app/v1/api/stream/createstream?id=${torrentId}&file_id=${videoFile.id}&type=torrent&chosen_subtitle_index=null&chosen_audio_index=0&chosen_resolution_index=null`,
          {
            headers: { Authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(12000),
          }
        );
        if (hlsRes.ok) {
          const hlsData = await hlsRes.json();
          hlsUrl = hlsData?.data?.hls_url || null;
        }
      } catch {}
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
