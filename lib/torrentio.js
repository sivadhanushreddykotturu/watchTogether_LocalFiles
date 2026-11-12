// Torrentio (the Stremio addon index) as the source of torrent candidates for TorBox.
//
// Torrentio aggregates ~15 trackers (YTS, ThePirateBay, TorrentGalaxy, 1337x, EXT, ...) and, given an IMDb id,
// returns releases with their size, seeders and (for series packs) the exact file name. We use it to FIND hashes.
//
// The viewer's TorBox key goes into the Torrentio request (the same `torbox=<key>` config a Stremio user sets), so
// Torrentio can check TorBox itself and, with `nodownloadlinks`, return only releases that are already cached.
// (Without a key, or if Torrentio can't use it, we retry keyless and check the cache ourselves.) Either way we then
// verify with TorBox directly, add only the one release we pick (add_only_if_cached, so nothing is downloaded), and
// stream it through TorBox's own transcoder. The resolve links Torrentio returns (which contain the key) are never kept.
//
// The functions are pure over an injectable `fetchImpl` so they can be tested without the network.

import { createHash } from 'node:crypto';

const TORRENTIO = 'https://torrentio.strem.fun';
const TORBOX = 'https://api.torbox.app/v1/api';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const GB = 1024 * 1024 * 1024;
const VIDEO_EXT = /\.(mkv|mp4|m4v|avi|webm|mov)$/i;
const MIN_FILE_BYTES = 50 * 1024 * 1024;
const MAX_ATTEMPTS = 3; // how many cached candidates we will actually add to the account before giving up

const baseName = (p) => String(p || '').split('/').pop();

// ---- small TTL cache so repeated plays of one title don't hammer the shared Torrentio instance ----
const cache = new Map();
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX = 200;
function cacheGet(k) {
  const h = cache.get(k);
  if (!h) return null;
  if (h.exp < Date.now()) {
    cache.delete(k);
    return null;
  }
  return h.v;
}
function cacheSet(k, v) {
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(k, { v, exp: Date.now() + CACHE_TTL_MS });
}

// ---- parsing ----
export function parseStream(x) {
  // Keyless answers carry `infoHash`/`fileIdx`; answers for a debrid user carry a resolve link instead:
  //   .../resolve/torbox/<key>/<hash>/<file name or null>/<file index or null>/<file name>
  let hash = String(x?.infoHash || '').toLowerCase();
  let fileIdx = Number.isInteger(x?.fileIdx) ? x.fileIdx : null;
  if (!/^[a-f0-9]{40}$/.test(hash) && x?.url) {
    const m = String(x.url).match(/\/resolve\/[a-z]+\/[^/]+\/([a-f0-9]{40})\/([^/]*)\/([^/]*)/i);
    if (m) {
      hash = m[1].toLowerCase();
      if (/^\d+$/.test(m[3])) fileIdx = Number(m[3]);
    }
  }
  if (!/^[a-f0-9]{40}$/.test(hash)) return null;
  const lines = String(x.title || '').split('\n');
  const head = lines[0] || '';
  const meta = lines.slice(1).join(' ');
  const nameText = String(x.name || '').replace(/\n/g, ' ');

  const sizeM = meta.match(/💾\s*([\d.]+)\s*(TB|GB|MB|KB)/i);
  const mult = { TB: 1024 ** 4, GB: GB, MB: 1024 ** 2, KB: 1024 };
  const bytes = sizeM ? Math.round(parseFloat(sizeM[1]) * mult[sizeM[2].toUpperCase()]) : null;
  const seeds = Number((meta.match(/👤\s*(\d+)/) || [])[1]) || 0;
  const source = ((meta.match(/⚙️\s*([^\n]+)$/) || [])[1] || '').trim();

  const resM = `${nameText} ${head}`.match(/(4320p|2160p|4k|1080p|720p|480p)/i);
  let res = resM ? resM[1].toLowerCase() : '';
  if (res === '4k' || res === '4320p') res = '2160p';

  return {
    hash,
    fileIdx,
    fileName: x.behaviorHints?.filename || null,
    cachedHint: /^\[TB\+\]/.test(String(x.name || '')), // Torrentio says TorBox has it cached (never trusted alone)
    name: head.trim(),
    bytes,
    gb: bytes == null ? null : bytes / GB,
    res,
    seeds,
    source,
    hevc: /x265|hevc|h\.?265/i.test(head),
    av1: /\bav1\b/i.test(head),
    hdr: /\bhdr\d*\+?\b|\bdv\b|dolby|\bdovi\b/i.test(`${nameText} ${head}`),
    h264: /x264|h\.?264|\bavc\b/i.test(head),
  };
}

// Higher is better. TorBox transcodes everything down to 1080p anyway, so 1080p sources are the sweet spot:
// 4K/HDR files are huge and slow for the transcoder, 720p and below only if nothing better is cached.
export function scoreCandidate(c) {
  let s = 0;
  s += { '1080p': 50, '720p': 40, '2160p': 25, '480p': 20, '': 30 }[c.res] ?? 30;
  if (c.h264) s += 4;
  if (c.av1) s -= 6;
  if (c.hdr) s -= 4;
  if (c.gb != null) {
    if (c.gb >= 1.2 && c.gb <= 8) s += 4;
    else if (c.gb < 0.8) s -= 4;
    else if (c.gb > 8) s -= 3;
  }
  s += Math.min(Math.log10(c.seeds + 1) * 2, 6);
  return s;
}

export function rankCandidates(list) {
  const best = new Map(); // one entry per hash (the same torrent can be listed by several trackers)
  for (const c of list) {
    const prev = best.get(c.hash);
    if (!prev || scoreCandidate(c) > scoreCandidate(prev)) best.set(c.hash, c);
  }
  return [...best.values()].sort((a, b) => scoreCandidate(b) - scoreCandidate(a));
}

// ---- search ----
async function fetchStreams(url, fetchImpl) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetchImpl(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(9000) });
      if (res.status === 429 || res.status >= 500) {
        await new Promise((r) => setTimeout(r, 800));
        continue;
      }
      if (!res.ok) return [];
      const json = await res.json();
      return Array.isArray(json?.streams) ? json.streams.map(parseStream).filter(Boolean) : [];
    } catch {
      await new Promise((r) => setTimeout(r, 400));
    }
  }
  return [];
}

// `token` is the viewer's TorBox key (optional). With it Torrentio returns only releases already cached on that account.
export async function searchTorrentio({ imdbId, isTv, season, episode, maxBytes, token = '', fetchImpl = fetch }) {
  if (!/^tt\d{5,10}$/.test(String(imdbId || ''))) return [];
  const id = isTv ? `${imdbId}:${Number(season) || 1}:${Number(episode) || 1}` : imdbId;
  const maxGb = Math.max(1, Math.floor(maxBytes / GB));
  // Cached status is per account, so results are cached per (title, account); the key itself is never stored.
  const who = token ? createHash('sha1').update(token).digest('hex').slice(0, 10) : 'anon';
  const cacheKey = `${isTv ? 's' : 'm'}|${id}|${maxGb}|${who}`;
  const hit = cacheGet(cacheKey);
  if (hit) return hit;

  // The same filters Stremio users put in their Torrentio config: no cams/screeners, and nothing over the size cap.
  const base = `qualityfilter=cam,scr%7Csizefilter=${maxGb}gb`;
  const path = `/stream/${isTv ? 'series' : 'movie'}/${id}.json`;
  let out = [];
  if (token) out = await fetchStreams(`${TORRENTIO}/${base}%7Cdebridoptions=nodownloadlinks%7Ctorbox=${encodeURIComponent(token)}${path}`, fetchImpl);
  if (!out.length) out = await fetchStreams(`${TORRENTIO}/${base}${path}`, fetchImpl); // keyless: we check the cache ourselves
  if (out.length) cacheSet(cacheKey, out);
  return out;
}

// ---- file choice inside a torrent ----
// Works on both TorBox's cached listing (name/size) and a torrent's file list after adding (with ids).
export function pickFile(files, { isTv, season, episode, wantedBase = '', maxBytes }) {
  const vids = (files || []).filter(
    (f) =>
      f &&
      VIDEO_EXT.test(baseName(f.name)) &&
      !/\bsample\b|\/screenshots\//i.test(f.name) &&
      !(Number(f.size) < MIN_FILE_BYTES) &&
      (f.size == null || Number(f.size) <= maxBytes)
  );
  if (!vids.length) return null;
  const bySizeDesc = (a, b) => Number(b.size || 0) - Number(a.size || 0);

  if (wantedBase) {
    const exact = vids.find((f) => baseName(f.name) === wantedBase);
    if (exact) return exact;
  }
  if (isTv) {
    const s = Number(season) || 1;
    const e = Number(episode) || 1;
    const re = new RegExp(`(?:\\bs0*${s}e0*${e}\\b|\\b${s}x0*${e}\\b|\\bepisode\\s*0?${e}\\b)`, 'i');
    // Never fall back to "some other episode": a wrong episode is worse than none.
    return vids.filter((f) => re.test(baseName(f.name))).sort(bySizeDesc)[0] || null;
  }
  const main = vids.filter((f) => !/\b(trailer|featurette|extras?|behind the scenes|bonus)\b/i.test(baseName(f.name)));
  return (main.length ? main : vids).sort(bySizeDesc)[0];
}

// ---- TorBox calls ----
async function checkCached(token, hashes, fetchImpl) {
  const res = await fetchImpl(`${TORBOX}/torrents/checkcached?format=list&list_files=true`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ hashes }),
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) return null;
  const j = await res.json();
  const map = new Map();
  for (const c of Array.isArray(j?.data) ? j.data : []) if (c?.hash) map.set(String(c.hash).toLowerCase(), c);
  return map;
}

async function addCached(token, hash, fetchImpl) {
  const form = new FormData();
  form.append('magnet', `magnet:?xt=urn:btih:${hash}`);
  form.append('add_only_if_cached', 'true'); // nothing is downloaded: it only succeeds if TorBox already has it
  const res = await fetchImpl(`${TORBOX}/torrents/createtorrent`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) return null;
  return (await res.json())?.data?.torrent_id || null;
}

async function listFiles(token, torrentId, fetchImpl) {
  const res = await fetchImpl(`${TORBOX}/torrents/mylist?id=${torrentId}&bypass_cache=true`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) return null;
  return (await res.json())?.data?.files || null;
}

// Find, verify and stream a title through Torrentio + TorBox.
//   Returns { ok: true, torrentId, file, candidate, hls } on success (or { ok: true, dryRun: true, candidate } with dryRun),
//   otherwise { ok: false, reason }.
export async function findViaTorrentio({
  token,
  imdbId,
  isTv,
  season,
  episode,
  maxBytes,
  createHls, // (torrentId, fileId) => Promise<hlsUrl|null>
  dryRun = false,
  fetchImpl = fetch,
}) {
  const capGb = Math.round(maxBytes / GB);
  const all = await searchTorrentio({ imdbId, isTv, season, episode, maxBytes, token, fetchImpl });
  if (!all.length) return { ok: false, reason: 'No releases found on Torrentio' };

  const within = all.filter((c) => c.bytes == null || c.bytes <= maxBytes);
  if (!within.length) return { ok: false, reason: `Every release is larger than ${capGb} GB` };

  const ranked = rankCandidates(within).slice(0, 25);
  let cached;
  try {
    cached = await checkCached(token, ranked.map((c) => c.hash), fetchImpl);
  } catch {
    cached = null;
  }
  if (!cached) return { ok: false, reason: 'TorBox cache check failed' };
  const cachedRanked = ranked.filter((c) => cached.has(c.hash));
  if (!cachedRanked.length) return { ok: false, reason: 'None of the releases are cached on TorBox' };

  let attempts = 0;
  for (const cand of cachedRanked) {
    if (attempts >= MAX_ATTEMPTS) break;
    const entry = cached.get(cand.hash);
    const opts = { isTv, season, episode, wantedBase: cand.fileName ? baseName(cand.fileName) : '', maxBytes };

    // Check the cached file listing first, so a candidate with no usable file is skipped without adding it to the account.
    const listing = Array.isArray(entry.files) && entry.files.length ? entry.files : null;
    if (listing && !pickFile(listing, opts)) continue;
    if (!listing && Number(entry.size) > maxBytes) continue;

    if (dryRun) return { ok: true, dryRun: true, candidate: cand, file: listing ? pickFile(listing, opts) : null };

    attempts++;
    const torrentId = await addCached(token, cand.hash, fetchImpl).catch(() => null);
    if (!torrentId) continue;
    const files = await listFiles(token, torrentId, fetchImpl).catch(() => null);
    const file = files && pickFile(files, opts);
    if (!file || file.id == null) continue;

    const hls = await createHls(torrentId, file.id).catch(() => null);
    if (hls) return { ok: true, torrentId, file, candidate: cand, hls };
  }
  return { ok: false, reason: `No cached release with a playable file under ${capGb} GB` };
}
