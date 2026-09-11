// Custom server: Next.js handles pages, Socket.IO handles realtime, one process.
// Render runs this as a long-lived service — that's what keeps WebSockets possible.

// Node 22 kills the process on unhandled rejections/exceptions by default.
// For a long-lived realtime server, a single bad async call (Clerk verify,
// Mongo blip, upstream proxy hiccup) must never take the whole service down —
// log it loudly (visible in Render logs) and keep serving.
process.on('unhandledRejection', (err) => {
  console.error('[reelsync] unhandledRejection:', err);
});
process.on('uncaughtException', (err) => {
  console.error('[reelsync] uncaughtException:', err);
});

const http = require('http');
const next = require('next');
const { Server } = require('socket.io');
const db = require('./db');
const realtime = require('./realtime');

const dev = process.env.NODE_ENV !== 'production';
const app = next({ dev });
const handle = app.getRequestHandler();

const PORT = process.env.PORT || 3000;

const https = require('https');
const urlModule = require('url');

async function resolveFreshPhHls(viewkey) {
  if (!viewkey) return null;
  try {
    const targetUrl = `https://www.pornhub.org/view_video.php?viewkey=${viewkey}`;
    const res = await fetch(targetUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Cookie': 'accessAgeDisclaimerPH=1; age_verified=1; platform=pc; bs=1',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      redirect: 'follow',
      cache: 'no-store',
    });
    if (!res.ok) return null;
    const html = await res.text();
    const flashvarsMatch = html.match(/flashvars_\d+\s*=\s*({.+?});/);
    if (!flashvarsMatch) return null;
    const flashvars = JSON.parse(flashvarsMatch[1]);
    const mediaDefs = Array.isArray(flashvars.mediaDefinitions) ? flashvars.mediaDefinitions : [];
    const hlsItems = mediaDefs.filter((m) => m.format === 'hls' && m.videoUrl);
    hlsItems.sort((a, b) => (Number(b.quality) || Number(b.height) || 0) - (Number(a.quality) || Number(a.height) || 0));
    return hlsItems[0]?.videoUrl || null;
  } catch (err) {
    console.error('[ph-refresh] Error resolving fresh stream for viewkey:', viewkey, err);
    return null;
  }
}

function handleHlsProxy(req, res, defaultReferer = '') {
  const parsed = urlModule.parse(req.url, true);
  let targetUrl = parsed.query.url;
  if (!targetUrl) {
    res.writeHead(400, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
    res.end('Missing url parameter');
    return;
  }

  const viewkey = parsed.query.viewkey || '';
  const isPhncdn = targetUrl.includes('phncdn.com') || targetUrl.includes('pornhub');

  // Re-attach any sub-query parameters that were parsed separately (e.g. &in=..., &q=...)
  // Exclude non-target query parameters so they are not appended to signed upstream URLs
  const nonTargetKeys = ['url', 'referer', 'viewkey', 'retry'];
  const extraParams = [];
  for (const [k, v] of Object.entries(parsed.query)) {
    if (!nonTargetKeys.includes(k) && typeof v === 'string') {
      extraParams.push(`${k}=${v}`);
    }
  }
  if (extraParams.length > 0) {
    const sep = targetUrl.includes('?') ? '&' : '?';
    targetUrl += sep + extraParams.join('&');
  }

  let referer = parsed.query.referer || defaultReferer;
  if (!referer) {
    if (isPhncdn) {
      referer = 'https://www.pornhub.org/';
    } else if (targetUrl.includes('redgifs.com')) {
      referer = 'https://www.redgifs.com/';
    } else if (targetUrl.includes('ahcdn.com') || targetUrl.includes('xhamster')) {
      referer = 'https://xhamster.com/';
    } else if (targetUrl.includes('net52.cc') || targetUrl.includes('makhi4.top') || targetUrl.includes('netmirror') || targetUrl.includes('nm-cdn')) {
      const idMatch = targetUrl.match(/(?:\/files\/|\/hls\/)(\d+)/);
      referer = idMatch ? `https://net52.cc/play.php?id=${idMatch[1]}` : 'https://net52.cc/';
    }
  }

  const clientIp = req.headers['x-forwarded-for'] ? req.headers['x-forwarded-for'].split(',')[0].trim() : req.socket.remoteAddress;

  const upstreamHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': '*/*',
  };
  // IMPORTANT: Do NOT send X-Forwarded-For or CF-Connecting-IP to token-signed CDNs like phncdn.com!
  // The token is signed for the proxy server's egress IP; forwarding the client IP causes CDN signature mismatch (410 Gone / 403).
  if (clientIp && !isPhncdn) {
    upstreamHeaders['X-Forwarded-For'] = clientIp;
    upstreamHeaders['CF-Connecting-IP'] = clientIp;
  }
  if (referer) upstreamHeaders['Referer'] = referer;
  if (referer && referer.includes('pornhub') && !targetUrl.includes('phncdn.com')) {
    upstreamHeaders['Cookie'] = 'accessAgeDisclaimerPH=1; age_verified=1; platform=pc; bs=1';
  }

  const clientReq = https.get(targetUrl, { headers: upstreamHeaders }, (upstreamRes) => {
    // If upstream returns 410 Gone (expired token) or 403 Forbidden on a Pornhub stream, attempt automatic refresh!
    if ((upstreamRes.statusCode === 410 || upstreamRes.statusCode === 403) && isPhncdn && viewkey && !parsed.query.retry) {
      console.warn(`[ph-proxy] Upstream returned ${upstreamRes.statusCode} for viewkey ${viewkey}, refreshing stream token...`);
      resolveFreshPhHls(viewkey).then((freshUrl) => {
        if (freshUrl) {
          let nextUrl = freshUrl;
          // If the requested target was a segment or child playlist, replace expired query tokens (?h=...&e=...) with fresh tokens
          if (!targetUrl.includes('master.m3u8') && freshUrl.includes('?')) {
            const freshQuery = freshUrl.split('?')[1];
            const baseTarget = targetUrl.split('?')[0];
            nextUrl = `${baseTarget}?${freshQuery}`;
          }
          const retryReq = {
            ...req,
            url: `/api/proxy/hls?url=${encodeURIComponent(nextUrl)}&viewkey=${encodeURIComponent(viewkey)}&retry=1${referer ? '&referer=' + encodeURIComponent(referer) : ''}`
          };
          handleHlsProxy(retryReq, res, referer);
          return;
        }
        res.writeHead(upstreamRes.statusCode, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
        res.end(`Upstream returned ${upstreamRes.statusCode} (token expired)`);
      }).catch((e) => {
        console.error('[ph-proxy] Token refresh failed:', e);
        res.writeHead(upstreamRes.statusCode, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
        res.end(`Upstream returned ${upstreamRes.statusCode}`);
      });
      return;
    }

    if (upstreamRes.statusCode >= 400) {
      res.writeHead(upstreamRes.statusCode, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
      res.end(`Upstream returned ${upstreamRes.statusCode}`);
      return;
    }

    const contentType = upstreamRes.headers['content-type'] || '';
    const isM3U8 = targetUrl.includes('.m3u8') || contentType.includes('mpegurl') || contentType.includes('application/x-mpegURL');

    if (isM3U8) {
      let data = '';
      upstreamRes.on('data', (chunk) => { data += chunk; });
      upstreamRes.on('end', () => {
        let origin = '';
        try {
          const parsedTarget = new URL(targetUrl);
          origin = parsedTarget.origin;
        } catch {
          const m = targetUrl.match(/^(https?:\/\/[^\/]+)/);
          if (m) origin = m[1];
        }
        const baseUrl = targetUrl.substring(0, targetUrl.lastIndexOf('/') + 1);

        const rewritten = data.split('\n').map((line) => {
          let modifiedLine = line;

          // Rewrite URI="..." in #EXT-X-MEDIA and #EXT-X-MAP (e.g. init-v1-a1.mp4, multi-track audio)
          if (modifiedLine.includes('URI="')) {
            modifiedLine = modifiedLine.replace(/URI="([^"]+)"/g, (match, p1) => {
              let abs = p1;
              if (abs.startsWith('/')) {
                abs = origin + abs;
              } else if (!abs.startsWith('http://') && !abs.startsWith('https://')) {
                abs = baseUrl + abs;
              }
              const proxyUrl = `/api/proxy/hls?url=${encodeURIComponent(abs)}${referer ? '&referer=' + encodeURIComponent(referer) : ''}${viewkey ? '&viewkey=' + encodeURIComponent(viewkey) : ''}`;
              return `URI="${proxyUrl}"`;
            });
          }

          const trimmed = modifiedLine.trim();
          if (!trimmed || trimmed.startsWith('#')) return modifiedLine;

          let absUrl = trimmed;
          if (absUrl.startsWith('/')) {
            absUrl = origin + absUrl;
          } else if (!absUrl.startsWith('http://') && !absUrl.startsWith('https://')) {
            absUrl = baseUrl + absUrl;
          }
          return `/api/proxy/hls?url=${encodeURIComponent(absUrl)}${referer ? '&referer=' + encodeURIComponent(referer) : ''}${viewkey ? '&viewkey=' + encodeURIComponent(viewkey) : ''}`;
        }).join('\n');

        res.writeHead(200, {
          'Content-Type': 'application/vnd.apple.mpegurl',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-cache, no-store, must-revalidate',
        });
        res.end(rewritten);
      });
      return;
    }

    // Direct zero-copy pipe for video/audio chunks & thumbnails (supporting .m4s fMP4, .mp4 init headers, .ts, .jpg, .webp, .png)
    let mime = 'video/MP2T';
    if (targetUrl.includes('.m4s') || targetUrl.includes('.mp4') || targetUrl.includes('init-') || contentType.includes('mp4') || contentType.includes('iso.segment')) {
      mime = 'video/mp4';
    } else if (contentType && contentType.includes('mpegurl')) {
      mime = 'application/vnd.apple.mpegurl';
    } else if (contentType && (contentType.includes('image') || contentType.includes('jpeg') || contentType.includes('png') || contentType.includes('webp'))) {
      mime = contentType;
    } else if (targetUrl.includes('.jpg') || targetUrl.includes('.jpeg')) {
      mime = 'image/jpeg';
    } else if (targetUrl.includes('.webp')) {
      mime = 'image/webp';
    } else if (targetUrl.includes('.png')) {
      mime = 'image/png';
    }

    res.writeHead(upstreamRes.statusCode, {
      'Content-Type': mime,
      'Content-Length': upstreamRes.headers['content-length'] || undefined,
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=86400',
    });
    upstreamRes.pipe(res);
  });

  clientReq.on('error', (err) => {
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
      res.end(err.message);
    }
  });
}

app.prepare().then(() => {
  const server = http.createServer((req, res) => {
    // Universal zero-copy HLS stream & image proxy
    if (req.url.startsWith('/api/proxy/hls') || req.url.startsWith('/api/ph/stream') || req.url.startsWith('/api/ph/thumb')) {
      handleHlsProxy(req, res);
      return;
    }

    // Render health check + UptimeRobot ping target (keeps the free instance awake).
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        mongo: db.isConnected(),
        rooms: realtime.roomCount(),
        uptime: Math.round(process.uptime()),
      }));
      return;
    }
    // NTP clock-sync: client uses this to calculate round-trip offset.
    if (req.url === '/api/ping-ntp') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ t: Date.now() }));
      return;
    }

    handle(req, res);
  });

  // Same-origin only: the pages and the sockets come from this one service.
  const io = new Server(server, {
    transports: ['websocket', 'polling'],
    pingInterval: 10000,
    pingTimeout: 5000,
    upgradeTimeout: 10000,
  });
  realtime.attach(io);

  db.connect().then(() => {
    server.listen(PORT, () => {
      console.log(`ReelSync running at http://localhost:${PORT} (${dev ? 'dev' : 'prod'})`);
    });
  });
});
