// Streams an Eporner MP4 through this server.
//
// Eporner's CDN answers any browser (cross-site) request for these MP4s with a 302 to a placeholder clip
// (static.eporner.com/na.mp4, "this video is only available at eporner.com"), whatever referrer policy the
// page sets. A plain server-side request has none of those browser headers, so it gets the real file.
// Range requests are forwarded so seeking works, redirects are never followed (so the placeholder is never
// served), and only Eporner hosts are accepted so this can't be used as an open relay.

const https = require('https');
const urlModule = require('url');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

function isEpornerUrl(raw) {
  let u;
  try {
    u = new URL(String(raw || ''));
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || (u.port && u.port !== '443') || u.username || u.password) return null;
  if (!/^([a-z0-9-]+\.)+eporner\.com$/i.test(u.hostname)) return null;
  if (u.href.length > 2000) return null;
  return u;
}

function createEpVideoProxy({ request = https.get } = {}) {
  return function handleEpVideoProxy(req, res) {
    const fail = (status, msg) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      res.writeHead(status, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
      res.end(msg);
    };

    if (req.method !== 'GET') return fail(405, 'GET only');
    const target = isEpornerUrl(urlModule.parse(req.url, true).query.url);
    if (!target) return fail(400, 'Not an Eporner video URL');

    const headers = { 'User-Agent': UA, Accept: '*/*' };
    if (req.headers.range) headers.Range = req.headers.range;

    const upstream = request(target, { headers }, (up) => {
      const status = up.statusCode || 502;
      // A redirect here is the "only available at eporner.com" placeholder (or something else unexpected): never follow it.
      if (status >= 300 && status < 400) {
        up.resume();
        return fail(502, 'Eporner would not serve this link');
      }
      if (status >= 400) {
        up.resume();
        return fail(status === 404 || status === 410 ? 410 : 502, `Upstream returned ${status}`);
      }
      const out = {
        'Content-Type': up.headers['content-type'] || 'video/mp4',
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-store',
        'X-Accel-Buffering': 'no', // tell nginx to stream instead of buffering a whole movie
      };
      if (up.headers['content-length']) out['Content-Length'] = up.headers['content-length'];
      if (up.headers['content-range']) out['Content-Range'] = up.headers['content-range'];
      res.writeHead(status, out);
      up.pipe(res);
    });

    upstream.setTimeout(20000, () => upstream.destroy(new Error('Upstream timed out')));
    upstream.on('error', (err) => fail(502, err.message || 'Upstream error'));
    // Viewer left (or seeked and the browser dropped this request): stop pulling the file.
    res.on('close', () => {
      if (!res.writableFinished) upstream.destroy();
    });
  };
}

module.exports = { createEpVideoProxy, isEpornerUrl, handleEpVideoProxy: createEpVideoProxy() };
