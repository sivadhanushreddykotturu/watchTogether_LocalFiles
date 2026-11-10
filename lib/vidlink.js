const fs = require('fs');
const path = require('path');
const nacl = require('./nacl.js');

// 1. Setup Node global environment for Go WebAssembly runtime
if (!globalThis.window) {
  globalThis.window = globalThis;
}
globalThis.sodium = {
  crypto_secretbox_easy: (m, n, k) => nacl.secretbox(m, n, k)
};

// 2. Load Go WebAssembly runtime
require('./script.js');

let wasmInstancePromise = null;

async function getWasmTokenGenerator() {
  if (globalThis.window && typeof globalThis.window.getAdv === 'function') {
    return globalThis.window.getAdv;
  }

  if (!wasmInstancePromise) {
    wasmInstancePromise = (async () => {
      const wasmPath = path.join(__dirname, 'fu.wasm');
      const wasmBuf = fs.readFileSync(wasmPath);
      const go = new globalThis.Dm();
      const { instance } = await WebAssembly.instantiate(wasmBuf, go.importObject);
      go.run(instance);
      if (typeof globalThis.window.getAdv !== 'function') {
        throw new Error('VidLink WASM failed to export window.getAdv');
      }
      return globalThis.window.getAdv;
    })();
  }

  return wasmInstancePromise;
}

/**
 * Build direct CloudFront signed URL with full public CORS support
 * @param {string} rawUrl
 * @param {string} cookieStr
 * @returns {string|null}
 */
function buildDirectSignedUrl(rawUrl, cookieStr = '') {
  if (!rawUrl || typeof rawUrl !== 'string') return null;
  let finalUrl = rawUrl;

  if (finalUrl.includes('flooderrr.store') || finalUrl.includes('surge.')) {
    try {
      const parsed = new URL(finalUrl);
      const host = parsed.searchParams.get('host') || 'https://sacdn.hakunaymatata.com';
      const sc = parsed.searchParams.get('sc');
      const pathname = parsed.pathname.replace(/^\/sacdn/, '');
      finalUrl = host + pathname;
      if (sc && !cookieStr) {
        cookieStr = Buffer.from(sc, 'base64').toString('utf8');
      }
    } catch (e) {
      console.warn('[VidLink Parse URL Warn]:', e.message);
    }
  }

  if (cookieStr) {
    const parts = cookieStr.split(';').map(p => p.trim()).filter(Boolean);
    const query = parts.map(p => p.replace('CloudFront-', '')).join('&');
    finalUrl += (finalUrl.includes('?') ? '&' : '?') + query;
  }

  return finalUrl;
}

/**
 * Pure HTTP / 0-Browser VidLink stream extractor
 * Runs 24/7 on EC2 or any device with zero Chrome overhead (~100-300ms)
 * @param {string|number} tmdbId
 * @param {'movie'|'tv'} type
 * @param {number} season
 * @param {number} episode
 * @returns {Promise<{ok: boolean, provider: string, streamType: string, streamUrl: string, subtitles: Array}|null>}
 */
async function extractVidlinkHttp(tmdbId, type = 'movie', season = 1, episode = 1) {
  try {
    const getAdv = await getWasmTokenGenerator();
    const token = getAdv(String(tmdbId));
    if (!token) return null;

    const pageUrl = type === 'tv'
      ? `https://vidlink.pro/tv/${tmdbId}/${season}/${episode}`
      : `https://vidlink.pro/movie/${tmdbId}`;

    const rawApiUrl = type === 'tv'
      ? `https://vidlink.pro/api/b/tv/${token}/${season}/${episode}?multiLang=0`
      : `https://vidlink.pro/api/b/movie/${token}?multiLang=0`;

    const WORKER_PROXY = 'https://d.ksdhanushreddy.workers.dev/proxy?url=';
    const targetUrls = [
      rawApiUrl,
      `${WORKER_PROXY}${encodeURIComponent(rawApiUrl)}`,
    ];

    const headers = {
      "referer": pageUrl,
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
      "x-playback-environment": "webkit"
    };

    for (const apiUrl of targetUrls) {
      try {
        const res = await fetch(apiUrl, {
          headers,
          signal: AbortSignal.timeout(4000),
        });

        if (res.ok) {
          const data = await res.json().catch(() => null);
          if (data?.stream?.playlist) {
            const cookieStr = data.stream.playlistHeaders?.Cookie || '';
            const signedUrl = buildDirectSignedUrl(data.stream.playlist, cookieStr);

            const subtitles = (data.stream.captions || [])
              .filter(c => c.url && c.language)
              .map((c, idx) => ({
                id: `vidlink-sub-${idx}`,
                lang: (c.language || 'en').toLowerCase().slice(0, 2),
                label: `${c.language} (VidLink)`,
                url: `/api/subtitles/proxy?url=${encodeURIComponent(c.url)}&provider=vidlink`,
                src: `/api/subtitles/proxy?url=${encodeURIComponent(c.url)}&provider=vidlink`,
                rawSrc: c.url,
                default: (c.language || '').toLowerCase() === 'english'
              }));

            return {
              ok: true,
              provider: 'VidLink',
              streamType: 'dash',
              streamUrl: signedUrl,
              rawUrl: signedUrl,
              subtitles
            };
          }
        }
      } catch (e) {
        // Try next fallback
      }
    }
  } catch (err) {
    console.warn('[VidLink WASM Extractor Warn]:', err.message);
  }

  return null;
}

module.exports = {
  extractVidlinkHttp,
  getWasmTokenGenerator,
  buildDirectSignedUrl,
};
