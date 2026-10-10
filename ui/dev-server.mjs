// SPDX-License-Identifier: Apache-2.0
// Fixture mock server for Track C, bound to loopback and never deployed.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { WebSocketServer } from 'ws';
await build({ entryPoints: ['mock-api.ts'], bundle: true, platform: 'node', format: 'esm', outfile: '.local/mock-api.mjs' });
const { createMock } = await import('./.local/mock-api.mjs');
const mock = createMock(process.env.UI_FIXTURE || 'conflict');
const replay = (await readFile(new URL('./fixtures/feed.jsonl', import.meta.url), 'utf8')).trim().split('\n').map(JSON.parse).filter(e => e.type);
const sockets = new WebSocketServer({ noServer: true });
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/__mock/replay' && req.method === 'POST') {
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}');
      for (const event of replay) { await new Promise(resolve => setTimeout(resolve, 180)); mock.apply(event); for (const socket of sockets.clients) if (socket.readyState === 1) socket.send(JSON.stringify(event)); }
      return;
    }
    const chunks = []; let bytes = 0;
    for await (const chunk of req) { bytes += chunk.length; if (bytes > 65536) { res.writeHead(413); res.end(); return; } chunks.push(chunk); }
    const request = new Request(url, { method: req.method, headers: req.headers, ...(chunks.length ? { body: Buffer.concat(chunks) } : {}) });
    const response = await mock.handle(request);
    if (response) { res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(Buffer.from(await response.arrayBuffer())); return; }
    const file = ['/app.js', '/style.css'].includes(url.pathname) ? url.pathname.slice(1) : 'index.html';
    res.writeHead(200, { 'Content-Type': file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html', 'Cache-Control': 'no-store' });
    res.end(await readFile(new URL(`./dist/${file}`, import.meta.url)));
  } catch { res.writeHead(500); res.end('Fixture server error'); }
});
server.on('upgrade', (req, socket, head) => {
  if (req.url !== '/api/projects/demo/ws') { socket.destroy(); return; }
  sockets.handleUpgrade(req, socket, head, ws => sockets.emit('connection', ws, req));
});
server.listen(Number(process.env.PORT || 4173), '127.0.0.1', () => console.log('Fixture UI at http://127.0.0.1:' + (process.env.PORT || 4173) + '/p/demo'));
