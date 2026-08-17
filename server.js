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

app.prepare().then(() => {
  const server = http.createServer((req, res) => {
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Embedder-Policy', 'credentialless');

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
