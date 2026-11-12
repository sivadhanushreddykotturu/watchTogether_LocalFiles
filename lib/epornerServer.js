// Server-side Eporner helpers (used by /api/ep and /api/ep/search). Not imported by client code.
//
// Search uses Eporner's official API (https://www.eporner.com/api/v2/). It throttles to roughly one request
// per second and answers 503 when hit in parallel, so every upstream call goes through one queue with a
// minimum gap, results are cached for a few minutes, and a 503/429 is retried once.
//
// Playable links come from the same internal call the site's own player makes (/xhr/video/<id>), the way
// open-source downloaders do. The MP4 links it returns are not tied to one IP, but Eporner's CDN redirects any
// browser (cross-site) request for them to a placeholder clip, so the links we hand out go through our own
// /api/ep/stream proxy (see epProxy.js), where the server fetches the real file.

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const API = 'https://www.eporner.com/api/v2';
const MIN_GAP_MS = 1100;
const SEARCH_TTL_MS = 3 * 60 * 1000;
const CACHE_MAX = 300;

export const EP_ORDERS = ['top-weekly', 'most-popular', 'top-rated', 'latest', 'longest', 'shortest'];

// ---- one-at-a-time queue with a minimum gap between upstream calls ----
let chain = Promise.resolve();
let lastCallAt = 0;

function enqueue(task) {
  const run = chain.then(async () => {
    const wait = lastCallAt + MIN_GAP_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    try {
      return await task();
    } finally {
      lastCallAt = Date.now();
    }
  });
  chain = run.catch(() => {});
  return run;
}

async function apiJson(path) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(`${API}/${path}`, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(12000) });
    if (res.status === 503 || res.status === 429) {
      await new Promise((r) => setTimeout(r, 1300));
      continue;
    }
    if (!res.ok) throw new Error(`Eporner API ${res.status}`);
    return res.json();
  }
  throw new Error('Eporner API is busy, try again');
}

// ---- tiny TTL cache ----
const cache = new Map();
function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (hit.exp < Date.now()) {
    cache.delete(key);
    return null;
  }
  return hit.value;
}
function cacheSet(key, value) {
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(key, { value, exp: Date.now() + SEARCH_TTL_MS });
}

function formatViews(n) {
  const v = Number(n) || 0;
  if (v >= 1e6) return `${(v / 1e6).toFixed(v >= 1e7 ? 0 : 1)}M views`;
  if (v >= 1e3) return `${Math.round(v / 1e3)}K views`;
  return `${v} views`;
}

// Search (or browse, when the query is empty). Returns { results, page, totalPages, hasMore }.
export async function searchEporner({ q = '', page = 1, order = 'top-weekly', perPage = 24 } = {}) {
  const query = String(q).trim().slice(0, 100);
  const pg = Math.min(Math.max(parseInt(page, 10) || 1, 1), 200);
  const ord = EP_ORDERS.includes(order) ? order : 'top-weekly';
  const key = `s|${query.toLowerCase()}|${pg}|${ord}|${perPage}`;
  const cached = cacheGet(key);
  if (cached) return cached;

  const params = new URLSearchParams({
    query,
    per_page: String(perPage),
    page: String(pg),
    thumbsize: 'big',
    order: ord,
    lq: '0', // skip the low-quality uploads
    format: 'json',
  });
  const j = await enqueue(() => apiJson(`video/search/?${params}`));
  const results = (j.videos || []).map((v) => ({
    id: v.id,
    title: v.title,
    thumbnail: v.default_thumb?.src || v.thumbs?.[0]?.src || '',
    duration: v.length_min || '',
    views: formatViews(v.views),
    author: 'Eporner',
    rating: v.rate,
    url: v.url,
    embedUrl: v.embed,
    platform: 'EP',
  }));
  const totalPages = Number(j.total_pages) || 1;
  const out = { results, page: Number(j.page) || pg, totalPages, hasMore: pg < totalPages };
  cacheSet(key, out);
  return out;
}

// ---- resolve a video id to direct MP4 links ----
const ID_RE = /^[A-Za-z0-9]{6,20}$/;

// The player's call wants the page's 32-hex hash re-encoded as four base-36 chunks.
function encodeHash(h) {
  return [0, 8, 16, 24].map((i) => parseInt(h.slice(i, i + 8), 16).toString(36)).join('');
}

function heightOf(label) {
  const m = String(label).match(/(\d{3,4})p/);
  return m ? Number(m[1]) : 0;
}

// Picks the best height at or below `want`, else the smallest one above it.
export function pickQuality(list, want) {
  const sorted = [...list].sort((a, b) => b.height - a.height);
  return sorted.find((q) => q.height <= want) || sorted[sorted.length - 1] || null;
}

export async function resolveEporner(id, wantHeight = 1080) {
  if (!ID_RE.test(String(id || ''))) throw new Error('Invalid Eporner video id');
  const pageRes = await fetch(`https://www.eporner.com/video-${id}/`, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' },
    redirect: 'follow',
    signal: AbortSignal.timeout(12000),
  });
  if (!pageRes.ok) throw new Error(`Eporner page ${pageRes.status}`);
  const html = await pageRes.text();
  const hash = (html.match(/\bhash\s*=\s*'([a-f0-9]{32})'/) || [])[1];
  if (!hash) throw new Error('Eporner page had no player hash');
  const title = ((html.match(/<meta property="og:title" content="([^"]+)"/) || [])[1] || '').replace(/&#0?39;|&#x27;/g, "'").replace(/&amp;/g, '&').replace(/\s*-\s*EPORNER.*$/i, '').trim();

  const url = `https://www.eporner.com/xhr/video/${id}?hash=${encodeHash(hash)}&domain=www.eporner.com&fallback=false&embed=false&supportedFormats=mp4&_=${Date.now()}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Referer: `https://www.eporner.com/video-${id}/`, 'X-Requested-With': 'XMLHttpRequest' },
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) throw new Error(`Eporner player data ${res.status}`);
  const j = await res.json();
  if (j.available === false) throw new Error(j.message || 'Video is not available');

  const qualities = Object.entries(j.sources?.mp4 || {})
    .map(([label, v]) => ({ label, height: heightOf(label), url: v?.src }))
    .filter((q) => q.url && q.height);
  if (qualities.length === 0) throw new Error('No playable MP4 sources');
  // The browser must never get the raw CDN link (it would be handed the placeholder clip): wrap it in our proxy.
  const viaProxy = (u) => `/api/ep/stream?url=${encodeURIComponent(u)}`;
  const wrapped = qualities.map((q) => ({ ...q, url: viaProxy(q.url) }));
  const best = pickQuality(wrapped, wantHeight);
  return {
    id,
    title,
    duration: Number(j.duration) || null,
    url: best.url,
    height: best.height,
    qualities: wrapped.sort((a, b) => b.height - a.height),
  };
}
