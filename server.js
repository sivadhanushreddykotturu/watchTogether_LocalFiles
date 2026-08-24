// Custom server: Next.js handles pages, Socket.IO handles realtime, one process.
// Render runs this as a long-lived service — that's what keeps WebSockets possible.

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

function handleHlsProxy(req, res, defaultReferer = '') {
  const parsed = urlModule.parse(req.url, true);
  let targetUrl = parsed.query.url;
  if (!targetUrl) {
    res.writeHead(400, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
    res.end('Missing url parameter');
    return;
  }

  // Re-attach any sub-query parameters that were parsed separately (e.g. &in=..., &q=...)
  const nonTargetKeys = ['url', 'referer'];
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
    if (targetUrl.includes('pornhub.com') || targetUrl.includes('phncdn.com')) {
      referer = 'https://www.pornhub.com/';
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
  if (clientIp) {
    upstreamHeaders['X-Forwarded-For'] = clientIp;
    upstreamHeaders['CF-Connecting-IP'] = clientIp;
  }
  if (referer) upstreamHeaders['Referer'] = referer;
  if (referer && referer.includes('pornhub')) {
    upstreamHeaders['Cookie'] = 'accessAgeDisclaimerPH=1; age_verified=1;';
  }

  const clientReq = https.get(targetUrl, { headers: upstreamHeaders }, (upstreamRes) => {
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
              const proxyUrl = `/api/proxy/hls?url=${encodeURIComponent(abs)}${referer ? '&referer=' + encodeURIComponent(referer) : ''}`;
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
          return `/api/proxy/hls?url=${encodeURIComponent(absUrl)}${referer ? '&referer=' + encodeURIComponent(referer) : ''}`;
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
    handle(req, res);
  });

  // Same-origin only: the pages and the sockets come from this one service.
  const io = new Server(server);
  realtime.attach(io);

  db.connect().then(() => {
    server.listen(PORT, () => {
      console.log(`ReelSync running at http://localhost:${PORT} (${dev ? 'dev' : 'prod'})`);
    });
  });
});
