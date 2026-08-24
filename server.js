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

function handlePhStream(req, res) {
  const parsed = urlModule.parse(req.url, true);
  const targetUrl = parsed.query.url;
  if (!targetUrl) {
    res.writeHead(400, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
    res.end('Missing url parameter');
    return;
  }

  const upstreamHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Referer': 'https://www.pornhub.com/',
    'Cookie': 'accessAgeDisclaimerPH=1; age_verified=1;',
    'Accept': '*/*',
  };

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
        const baseUrl = targetUrl.substring(0, targetUrl.lastIndexOf('/') + 1);
        const rewritten = data.split('\n').map((line) => {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith('#')) return line;
          let absUrl = trimmed;
          if (!trimmed.startsWith('http://') && !trimmed.startsWith('https://')) {
            absUrl = baseUrl + trimmed;
          }
          return `/api/ph/stream?url=${encodeURIComponent(absUrl)}`;
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

    // Direct pipe for .ts chunks: 0 memory overhead, direct zero-copy socket streaming!
    res.writeHead(upstreamRes.statusCode, {
      'Content-Type': contentType || 'video/MP2T',
      'Content-Length': upstreamRes.headers['content-length'] || undefined,
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=3600',
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
    // Zero-copy direct streaming for PH HLS video chunks
    if (req.url.startsWith('/api/ph/stream')) {
      handlePhStream(req, res);
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
