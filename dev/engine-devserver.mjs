// SPDX-License-Identifier: Apache-2.0
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { emptyState, executeFixture } from './stub-engine.mjs';
const commands = new Set(['restore', 'snapshot', 'init', 'task.create', 'agent.enroll', 'lane.open', 'ingest', 'candidates', 'diff', 'discuss', 'decide', 'publish', 'why', 'selftest']);
export async function startEngineDevserver({ port = Number(process.env.ENGINE_DEV_PORT ?? 8789), engine = process.env.ENGINE_SCRIPT ?? resolve('engine/engine.mjs'), root = process.env.ENGINE_STATE_ROOT ?? '/home/scratch/heddle-engine-dev', stub = process.env.ENGINE_STUB === '1' } = {}) {
  const states = new Map();
  const server = createServer(async (req, res) => {
    try {
      const match = req.url.match(/^\/projects\/([a-z0-9][a-z0-9-]{0,62})\/([a-z.]+)$/);
      if (!match || req.method !== 'POST' || !commands.has(match[2])) { res.writeHead(404).end(); return; }
      const [, project, command] = match;
      if (stub) {
        let input = ''; for await (const b of req) input += b;
        let state = states.get(project) ?? emptyState(), result;
        if (command === 'restore') { state = JSON.parse(input); result = { generation: state.generation }; }
        else if (command === 'snapshot') { res.writeHead(200, { 'content-type': 'application/zstd' }).end(JSON.stringify(state)); return; }
        else result = executeFixture(state, command, JSON.parse(input));
        states.set(project, state); res.writeHead(result.error ? 422 : 200, { 'content-type': 'application/json' }).end(JSON.stringify(result) + '\n'); return;
      }
      const stateDir = join(root, project); await mkdir(stateDir, { recursive: true });
      const incoming = JSON.parse(req.headers['x-engine-env'] ?? '{}');
      const env = { ...process.env, ENGINE_STATE_DIR: stateDir, HEDDLE_STATE_DIR: stateDir, STATE_DIR: stateDir };
      for (const key of ['ARTIFACTS_READ_TOKENS', 'ARTIFACTS_WRITE_TOKEN']) if (typeof incoming[key] === 'string') env[key] = incoming[key];
      const child = spawn(process.execPath, [engine, command], { env, cwd: resolve('.') });
      const stdout = []; let diagnostics = '';
      child.stderr.on('data', chunk => { if (process.env.ENGINE_DEV_DIAGNOSTICS === '1' && diagnostics.length < 4096) diagnostics += chunk.toString().slice(0, 4096 - diagnostics.length); });
      if (command === 'snapshot') { res.writeHead(200, { 'content-type': 'application/zstd' }); child.stdout.pipe(res, { end: false }); }
      else child.stdout.on('data', b => stdout.push(b));
      child.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end('{"error":{"code":"crash","message":"Engine process failed"}}'); });
      child.on('close', code => {
        if (process.env.ENGINE_DEV_DIAGNOSTICS === '1' && code !== 0) {
          let failure = 'no-json-error';
          try { const parsed = JSON.parse(Buffer.concat(stdout).toString()); if (/^[a-z_]{1,40}$/.test(parsed.error?.code)) failure = parsed.error.code;
            if (/^(git|heddle|tar|npm) failed \(exit [-0-9]+(, [a-z ]+)?\)$/.test(parsed.error?.message)) failure += ` (${parsed.error.message})`; } catch {}
          const frames = diagnostics.split('\n').filter(line => /^engine\/(?:lib\/|test\/)?[a-z-]+\.mjs:\d+:\d+$/.test(line)).slice(0, 4);
          console.error(`Engine command ${command} exit ${code}, code ${failure}${frames.length ? ` at ${frames.join(', ')}` : ''}`);
        }
        if (command === 'snapshot') { if (code === 0) res.end(); else res.destroy(); }
        else { res.writeHead(code === 0 ? 200 : code === 2 ? 422 : 502, { 'content-type': 'application/json' }); res.end(Buffer.concat(stdout)); }
      });
      req.pipe(child.stdin);
    } catch { if (!res.headersSent) res.writeHead(502); res.end('{"error":{"code":"crash","message":"Engine request failed"}}'); }
  });
  await new Promise(r => server.listen(port, '127.0.0.1', r));
  return { server, origin: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(r => { server.close(r); server.closeAllConnections(); }) };
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) { const { origin } = await startEngineDevserver(); console.log(`engine-devserver listening ${origin}; fixture=${process.env.ENGINE_STUB === '1'}`); }
