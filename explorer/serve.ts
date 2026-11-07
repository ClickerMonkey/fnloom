// Serves the explorer on the LAN so it can be opened from another device: npm run explorer:serve
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const port = Number(process.env['PORT'] ?? 4180);
const file = path.join(import.meta.dirname, 'explorer.html');

http.createServer((req, res) => {
  if (req.url !== '/' && !req.url?.startsWith('/?') && req.url !== '/explorer.html') {
    res.writeHead(404).end('not found');
    return;
  }
  // read on every request so a rebuild shows up on refresh
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(fs.readFileSync(file));
}).listen(port, '0.0.0.0', () => console.log(`explorer on http://0.0.0.0:${port}/`));
