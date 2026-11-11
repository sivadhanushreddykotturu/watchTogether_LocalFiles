const nacl = require('./nacl.js');

// 32-byte secretbox key
const VIDLINK_KEY = new Uint8Array([
  199, 81, 54, 197, 102, 139, 191, 230,
  90, 126, 202, 212, 49, 167, 69, 219,
  104, 181, 243, 129, 85, 91, 56, 216,
  246, 198, 153, 68, 156, 241, 31, 205
]);

const ZERO_NONCE = new Uint8Array(24);
const WORKER_PROXY = 'https://d.ksdhanushreddy.workers.dev/proxy?url=';

/**
 * Generate XSalsa20-Poly1305 encrypted token for VidLink API
 * Payload: TMDB ID string + 64-bit Big-Endian Unix Timestamp (+120s expiry)
 * Nonce: 24 zero bytes
 * @param {string|number} tmdbId
 * @returns {string} Encrypted token string
 */
function generateVidlinkToken(tmdbId) {
  const idBytes = Buffer.from(String(tmdbId), 'utf8');
  const expiry = Math.floor(Date.now() / 1000) + 120; // 2 minutes forward expiry

  const tsBuf = Buffer.alloc(8);
  tsBuf.writeBigUInt64BE(BigInt(expiry));

  const payload = Buffer.concat([idBytes, tsBuf]);
  const ciphertext = nacl.secretbox(new Uint8Array(payload), ZERO_NONCE, VIDLINK_KEY);

  // 32 'A's represent 24 zero bytes base64 prefix
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
 * Runs 24/7 on EC2 or any device with zero Chrome overhead (~100-200ms)
 * @param {string|number} tmdbId
 * @param {'movie'|'tv'} type
 * @param {number} season
 * @param {number} episode
 * @returns {Promise<{ok: boolean, provider: string, streamType: string, streamUrl: string, subtitles: Array}|null>}
 */
async function extractVidlinkHttp(tmdbId, type = 'movie', season = 1, episode = 1) {
  try {
    const token = generateVidlinkToken(tmdbId);
    if (!token) return null;

    const pageUrl = type === 'tv'
      ? `https://vidlink.pro/tv/${tmdbId}/${season}/${episode}`
      : `https://vidlink.pro/movie/${tmdbId}`;

    const rawApiUrl = type === 'tv'
      ? `https://vidlink.pro/api/b/tv/${token}/${season}/${episode}?multiLang=0`
      : `https://vidlink.pro/api/b/movie/${token}?multiLang=0`;

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

            const codec = (data.stream.playbackMetadata?.codecName || 'h264').toLowerCase();

            return {
              ok: true,
              provider: 'VidLink',
              streamType: 'dash',
              streamUrl: signedUrl,
              rawUrl: signedUrl,
              codec,
              subtitles
            };
          }
        }
      } catch (e) {
        // Try next fallback
      }
    }
  } catch (err) {
    console.warn('[VidLink Extractor Warn]:', err.message);
  }

  return null;
}

module.exports = {
  extractVidlinkHttp,
  generateVidlinkToken,
  buildDirectSignedUrl,
};
