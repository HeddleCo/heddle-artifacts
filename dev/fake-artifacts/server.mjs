// SPDX-License-Identifier: Apache-2.0
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { FakeArtifacts } from './binding.mjs';

export async function startFakeArtifacts({ root = process.env.FAKE_ARTIFACTS_ROOT ?? '/home/scratch/heddle-fake-artifacts', port = Number(process.env.FAKE_ARTIFACTS_PORT ?? 8788), eventUrl = process.env.EVENT_URL, now, advertiseAtomic = true } = {}) {
  const binding = new FakeArtifacts({ root, eventUrl, now, advertiseAtomic });
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, binding.origin);
      if (url.pathname === '/__binding' && req.method === 'POST') {
        let body = ''; for await (const b of req) { body += b; if (body.length > 65536) throw new Error('body_limit'); }
        const { repo, method, args = [] } = JSON.parse(body);
        const namespaceMethods = ['create', 'get', 'list', 'delete'];
        const repoMethods = ['info', 'log', 'readCommit', 'fork', 'createToken', 'listTokens', 'revokeToken'];
        if (!(repo ? repoMethods : namespaceMethods).includes(method)) { res.writeHead(400).end(); return; }
        const target = repo ? await binding.get(repo) : binding;
        const result = method === 'get' && !repo ? (await target.get(...args), {}) : await target[method](...args);
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result)); return;
      }
      const match = url.pathname.match(/^\/git\/heddle-demo\/([a-z0-9][a-z0-9-]{0,62})\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/);
      if (!match) { res.writeHead(404).end(); return; }
      const auth = req.headers.authorization ?? '';
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : auth.startsWith('Basic ') ? Buffer.from(auth.slice(6), 'base64').toString().split(':').slice(1).join(':') : '';
      const write = match[2] === 'git-receive-pack' || url.searchParams.get('service') === 'git-receive-pack';
      if (!await binding.authorize(match[1], token, write)) { res.writeHead(403).end('Forbidden'); return; }
      const child = spawn('git', ['http-backend'], { env: { ...process.env, GIT_PROJECT_ROOT: binding.root, GIT_HTTP_EXPORT_ALL: '1', PATH_INFO: `/${match[1]}.git/${match[2]}`, QUERY_STRING: url.search.slice(1), REQUEST_METHOD: req.method, CONTENT_TYPE: req.headers['content-type'] ?? '', CONTENT_LENGTH: req.headers['content-length'] ?? '', REMOTE_USER: 'token', HTTP_GIT_PROTOCOL: req.headers['git-protocol'] ?? '' } });
      let buffer = Buffer.alloc(0), headersSent = false;
      child.stdout.on('data', chunk => {
        if (headersSent) { res.write(chunk); return; }
        buffer = Buffer.concat([buffer, chunk]); const at = buffer.indexOf('\r\n\r\n'); if (at < 0) return;
        const headers = {}, lines = buffer.subarray(0, at).toString().split('\r\n'); let status = 200;
        for (const line of lines) { const colon = line.indexOf(':'); const k = line.slice(0, colon).toLowerCase(), v = line.slice(colon + 1).trim(); if (k === 'status') status = Number(v.split(' ')[0]); else headers[k] = v; }
        res.writeHead(status, headers); headersSent = true; res.write(buffer.subarray(at + 4)); buffer = Buffer.alloc(0);
      });
      child.stderr.resume(); child.on('error', () => { if (!res.headersSent) res.writeHead(500); res.end(); });
      child.on('close', () => res.end()); req.pipe(child.stdin);
    } catch (error) {
      if (!res.headersSent && error?.name === 'ArtifactsError' && typeof error.code === 'string' && Number.isInteger(error.numericCode)) {
        const status = error.code === 'NOT_FOUND' ? 404 : error.code === 'ALREADY_EXISTS' ? 409 : 503;
        res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { name: error.name, code: error.code, numericCode: error.numericCode } }));
      } else { if (!res.headersSent) res.writeHead(400); res.end('Fake Artifacts request failed'); }
    }
  });
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  binding.origin = `http://127.0.0.1:${server.address().port}`;
  return { binding, server, origin: binding.origin, close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }) };
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const { origin } = await startFakeArtifacts(); console.log(`fake-artifacts listening ${origin}`);
}
