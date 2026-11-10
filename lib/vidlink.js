const nacl = require('tweetnacl');

// VidLink 32-byte secretbox key extracted from WASM runtime
const VIDLINK_KEY = new Uint8Array([
  199, 81, 54, 197, 102, 139, 191, 230,
  90, 126, 202, 212, 49, 167, 69, 219,
  104, 181, 243, 129, 85, 91, 56, 216,
  246, 198, 153, 68, 156, 241, 31, 205
]);

// 24 zero bytes nonce
const ZERO_NONCE = new Uint8Array(24);

/**
 * Generate XSalsa20-Poly1305 encrypted token for VidLink API
 * @param {string|number} tmdbId
 * @returns {string} Encrypted token string
 */
function generateVidlinkToken(tmdbId) {
  const idBytes = Buffer.from(String(tmdbId), 'utf8');
  const now = Math.floor(Date.now() / 1000);

  // 8-byte big-endian Unix timestamp
  const tsBuf = Buffer.alloc(8);
  tsBuf.writeBigUInt64BE(BigInt(now));

  const payload = Buffer.concat([idBytes, tsBuf]);
  const ciphertext = nacl.secretbox(new Uint8Array(payload), ZERO_NONCE, VIDLINK_KEY);

  // 32 'A's represent the 24 zero bytes in Base64
  const prefix = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  return prefix + Buffer.from(ciphertext).toString('base64url');
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
 * Runs 24/7 on any server without Chrome or Puppeteer
 * @param {string|number} tmdbId
 * @param {'movie'|'tv'} type
 * @param {number} season
 * @param {number} episode
 * @returns {Promise<{ok: boolean, provider: string, streamType: string, streamUrl: string, subtitles: Array}|null>}
 */
async function extractVidlinkHttp(tmdbId, type = 'movie', season = 1, episode = 1) {
  const pageUrl = type === 'tv'
    ? `https://vidlink.pro/tv/${tmdbId}/${season}/${episode}`
    : `https://vidlink.pro/movie/${tmdbId}`;

  // 1. Warm edge cache by visiting page
  try {
    const pageRes = await fetch(pageUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
      },
      signal: AbortSignal.timeout(3000),
    });
    await pageRes.text().catch(() => '');
  } catch (e) {
    // Non-fatal, proceed to API
  }

  const headers = {
    "sec-ch-ua-platform": "\"Windows\"",
    "referer": pageUrl,
    "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
    "sec-ch-ua": "\"Not:A-Brand\";v=\"8\", \"Chromium\";v=\"156\", \"Google Chrome\";v=\"156\"",
    "x-playback-environment": "webkit",
    "sec-ch-ua-mobile": "?0"
  };

  // 2. Fetch API with rapid retry
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) {
      await new Promise(r => setTimeout(r, 200 * attempt));
    }

    const token = generateVidlinkToken(tmdbId);
    const apiUrl = type === 'tv'
      ? `https://vidlink.pro/api/b/tv/${token}/${season}/${episode}?multiLang=0`
      : `https://vidlink.pro/api/b/movie/${token}?multiLang=0`;

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
      // Loop retry
    }
  }

  return null;
}

module.exports = {
  extractVidlinkHttp,
  generateVidlinkToken,
  buildDirectSignedUrl,
};
