const http = require('http');
const https = require('https');
const path = require('path');
const puppeteer = require('puppeteer-core');

const APP_DIR = path.resolve(__dirname, '..');
process.loadEnvFile(path.join(APP_DIR, '.env'));

const { io } = require(path.join(APP_DIR, 'node_modules', 'socket.io-client'));
const { extractKisskhHttp } = require(path.join(APP_DIR, 'lib', 'kisskh.js'));

const PORT = 4545;
const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const REMOTE_SERVER = process.env.REELSYNC_SERVER || 'https://reelsync.duckdns.org';

let browserInstance = null;

async function getBrowser() {
  if (!browserInstance || !browserInstance.isConnected()) {
    browserInstance = await puppeteer.launch({
      executablePath: CHROME_PATH,
      headless: 'new',
      args: ['--no-sandbox', '--disable-gpu'],
    });
  }
  return browserInstance;
}

// In-flight request deduplication map (id -> Promise)
const inFlightRequests = new Map();

// Helper: Convert VidLink proxy URLs or CloudFront cookies into direct, signed CDN URLs with full public CORS
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

// Provider 1: VidFast (HLS .m3u8)
async function extractVidfast(browser, tmdbId, type = 'movie', season = 1, episode = 1, trackPage = p => p) {
  const page = await browser.newPage();
  trackPage(page);
  await page.setViewport({ width: 1280, height: 720 });
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36');

  const targetUrl = type === 'tv'
    ? `https://vidfast.vc/tv/${tmdbId}/${season}/${episode}`
    : `https://vidfast.vc/movie/${tmdbId}`;

  return new Promise((resolve, reject) => {
    let resolved = false;

    const timeout = setTimeout(async () => {
      if (!resolved) {
        resolved = true;
        await page.close().catch(() => {});
        reject(new Error('VidFast timeout'));
      }
    }, 12000);

    page.on('response', async (res) => {
      const u = res.url();
      if ((u.includes('.m3u8') || u.includes('/master.')) && !u.includes('.js') && !resolved) {
        resolved = true;
        clearTimeout(timeout);
        await page.close().catch(() => {});
        resolve({
          ok: true,
          provider: 'VidFast',
          streamType: 'hls',
          streamUrl: u,
        });
      }
    });

    page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 12000 }).catch(() => {});

    setTimeout(async () => {
      if (!resolved) {
        await page.mouse.click(640, 360).catch(() => {});
      }
    }, 2500);
  });
}

// Provider 2: VidLink (DASH .mpd with direct signed CloudFront URL)
async function extractVidlink(browser, tmdbId, type = 'movie', season = 1, episode = 1, trackPage = p => p) {
  const page = await browser.newPage();
  trackPage(page);

  const targetUrl = type === 'tv'
    ? `https://vidlink.pro/tv/${tmdbId}/${season}/${episode}`
    : `https://vidlink.pro/movie/${tmdbId}`;

  return new Promise((resolve, reject) => {
    let resolved = false;

    const timeout = setTimeout(async () => {
      if (!resolved) {
        resolved = true;
        await page.close().catch(() => {});
        reject(new Error('VidLink timeout'));
      }
    }, 12000);

    page.on('response', async (res) => {
      const u = res.url();
      if ((u.includes('index_web.mpd') || u.includes('.mpd')) && !resolved) {
        const signedUrl = buildDirectSignedUrl(u);
        if (signedUrl) {
          resolved = true;
          clearTimeout(timeout);
          await page.close().catch(() => {});
          resolve({
            ok: true,
            provider: 'VidLink',
            streamType: 'dash',
            streamUrl: signedUrl,
          });
          return;
        }
      }

      if (u.includes('/api/b/') && !resolved) {
        try {
          const text = await res.text().catch(() => null);
          if (text) {
            const json = JSON.parse(text);
            if (json?.stream?.playlist) {
              const cookieStr = json?.stream?.playlistHeaders?.Cookie || '';
              const signedUrl = buildDirectSignedUrl(json.stream.playlist, cookieStr);
              if (signedUrl) {
                resolved = true;
                clearTimeout(timeout);
                await page.close().catch(() => {});
                resolve({
                  ok: true,
                  provider: 'VidLink',
                  streamType: 'dash',
                  streamUrl: signedUrl,
                });
                return;
              }
            }
          }
        } catch (e) {
          console.warn('[VidLink Parse Warn]:', e.message);
        }
      }
    });

    page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 12000 }).catch(() => {});
  });
}

// Provider 3: CineSrc (HLS .m3u8 with direct 1080p / 720p public CORS)
async function extractCinesrc(browser, tmdbId, type = 'movie', season = 1, episode = 1, trackPage = p => p) {
  const page = await browser.newPage();
  trackPage(page);
  await page.setViewport({ width: 1280, height: 720 });
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36');

  const targetUrl = type === 'tv'
    ? `https://cinesrc.st/embed/tv/${tmdbId}?s=${season}&e=${episode}`
    : `https://cinesrc.st/embed/movie/${tmdbId}`;

  return new Promise((resolve, reject) => {
    let resolved = false;

    const timeout = setTimeout(async () => {
      if (!resolved) {
        resolved = true;
        await page.close().catch(() => {});
        reject(new Error('CineSrc timeout'));
      }
    }, 12000);

    page.on('response', async (res) => {
      const u = res.url();
      if (u.includes('/api/playlist/') && u.endsWith('.m3u8') && !resolved) {
        resolved = true;
        clearTimeout(timeout);
        await page.close().catch(() => {});
        resolve({
          ok: true,
          provider: 'CineSrc',
          streamType: 'hls',
          streamUrl: u,
        });
      }
    });

    page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 12000 }).catch(() => {});

    setTimeout(async () => {
      if (!resolved) {
        await page.mouse.click(640, 360).catch(() => {});
      }
    }, 2000);
  });
}

// Provider 4: KissKH (Pure HTTP 0-Chrome fast resolver with authentic subtitles)
async function extractKisskh(tmdbId, type = 'movie', season = 1, episode = 1) {
  return extractKisskhHttp(tmdbId, type, season, episode);
}

// Parallel Race: 5-Second Window for High-Quality Providers (VidLink / CineSrc / VidFast), then KissKH Fallback
async function resolveFastestStream(tmdbId, type = 'movie', season = 1, episode = 1) {
  const cacheKey = `${type}:${tmdbId}:${season}:${episode}`;
  if (inFlightRequests.has(cacheKey)) {
    return inFlightRequests.get(cacheKey);
  }

  const promise = (async () => {
    const browser = await getBrowser();
    const activePages = new Set();
    const trackPage = (p) => { activePages.add(p); return p; };
    const closeAll = () => {
      for (const p of activePages) {
        try { p.close().catch(() => {}); } catch {}
      }
      activePages.clear();
    };

    try {
      console.log(`[Auto-Resolver] Racing 1080p providers for TMDB ${type} ${tmdbId} (5s priority window)...`);

      // 1. Launch KissKH in background
      const kisskhPromise = extractKisskh(tmdbId, type, season, episode).catch(() => null);

      // 2. High-Quality Providers (VidLink DASH 1080p, CineSrc 1080p, VidFast 1080p)
      const primaryRace = Promise.any([
        extractVidlink(browser, tmdbId, type, season, episode, trackPage),
        extractCinesrc(browser, tmdbId, type, season, episode, trackPage),
        extractVidfast(browser, tmdbId, type, season, episode, trackPage),
      ]);

      // Give them a full 5.0 seconds as requested by user
      const primaryTimeout = new Promise((resolve) => setTimeout(() => resolve(null), 5000));
      const primaryWinner = await Promise.race([primaryRace, primaryTimeout]);

      if (primaryWinner && primaryWinner.ok && primaryWinner.streamUrl) {
        closeAll();
        console.log(`[Auto-Resolver] ⚡ Primary 1080p Winner: ${primaryWinner.provider} (${primaryWinner.streamType})`);
        return primaryWinner;
      }

      // 3. Fallback to KissKH after 5 seconds if primary providers missed or timed out
      console.log(`[Auto-Resolver] 5s window elapsed. Checking KissKH fallback for ${type} ${tmdbId}...`);
      closeAll();
      const kisskhWinner = await kisskhPromise;
      if (kisskhWinner && kisskhWinner.ok && kisskhWinner.streamUrl) {
        console.log(`[Auto-Resolver] ⚡ KissKH Match: ${kisskhWinner.streamUrl.substring(0, 80)}...`);
        return kisskhWinner;
      }

      return { ok: false, error: 'All providers failed to extract stream' };
    } catch (err) {
      closeAll();
      return { ok: false, error: 'All providers failed to extract stream' };
    } finally {
      closeAll();
      inFlightRequests.delete(cacheKey);
    }
  })();

  inFlightRequests.set(cacheKey, promise);
  return promise;
}

// -------------------------------------------------------------
// 1. Socket.IO Worker Bridge: Connect to Remote ReelSync Server
// -------------------------------------------------------------
const socket = io(REMOTE_SERVER, {
  transports: ['websocket'],
  reconnection: true,
  reconnectionDelay: 2000,
});

socket.on('connect', () => {
  console.log(`[Auto-Resolver] ⚡ Connected to ${REMOTE_SERVER} via WebSocket!`);
  socket.emit('register-resolver');
});

socket.on('resolve-stream', async (data) => {
  const { reqId, id, type, s, e } = data;
  console.log(`[Auto-Resolver] 🎬 Server requested stream: ${type} ${id} (S${s}:E${e})`);
  try {
    const result = await resolveFastestStream(id, type, s, e);
    socket.emit('resolve-stream-done', { reqId, ...result });
  } catch (err) {
    socket.emit('resolve-stream-done', { reqId, ok: false, error: err.message });
  }
});

socket.on('disconnect', () => {
  console.log(`[Auto-Resolver] ⚠️ Disconnected from ${REMOTE_SERVER}. Reconnecting...`);
});

// -------------------------------------------------------------
// 2. HTTP Server on port 4545 for local queries & health checks
// -------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === '/resolve') {
    const id = url.searchParams.get('id');
    const type = url.searchParams.get('type') || 'movie';
    const season = url.searchParams.get('s') || 1;
    const episode = url.searchParams.get('e') || 1;

    if (!id) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: 'Missing TMDB id parameter' }));
    }

    const start = Date.now();
    const result = await resolveFastestStream(id, type, season, episode);
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);

    if (result.ok) {
      console.log(`[Auto-Resolver] Winner: ${result.provider} in ${elapsed}s`);
    } else {
      console.log(`[Auto-Resolver] Failed in ${elapsed}s: ${result.error}`);
    }

    res.writeHead(result.ok ? 200 : 500, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(result));
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
});

server.listen(PORT, () => {
  console.log(`\n======================================================`);
  console.log(`ReelSync Quad Parallel Stream Resolver (5s 1080p Priority + KissKH Fallback)`);
  console.log(`Local HTTP server listening on port ${PORT}`);
  console.log(`Remote WebSocket bridge connected to ${REMOTE_SERVER}`);
  console.log(`======================================================\n`);
});
