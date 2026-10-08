// Local HTTP API / HTTPS CDN stand-in for the nginx image tests. No external media service.
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';

const serve = (req, res) => {
  let bytes = 0;
  req.on('data', b => { bytes += b.length; });
  req.on('end', () => {
    if (req.url.startsWith('/dataset/')) {
      if (req.url.includes('missing')) { res.writeHead(404); res.end('missing'); return; }
      res.writeHead(200, {
        'Content-Type': req.url.includes('/images/') ? 'image/jpeg' : 'image/gif',
        'Cache-Control': 'public, max-age=60',
        'Expires': 'Wed, 01 Jan 2030 00:00:00 GMT',
        'Set-Cookie': 'cdn-cookie=unwanted',
        'X-Upstream-Path': req.url,
        'X-Upstream-Host': req.headers.host,
        'X-Upstream-Sni': req.socket.servername || '',
        'X-Upstream-Cookie': req.headers.cookie || '',
        'X-Upstream-Authorization': req.headers.authorization || '',
        'X-Upstream-Real-IP': req.headers['x-real-ip'] || ''
      });
      res.end(req.url.includes('/images/') ? 'JPEG fixture' : 'GIF89a fixture');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, path: req.url, headers: req.headers, bytes }));
  });
};

http.createServer(serve).listen(3000);
https.createServer({
  key: fs.readFileSync('/fixtures/key.pem'), cert: fs.readFileSync('/fixtures/cert.pem')
}, serve).listen(3443);
