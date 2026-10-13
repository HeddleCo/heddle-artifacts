// SPDX-License-Identifier: Apache-2.0
import { run, Rejection } from './lib/process.mjs';
import { load, save, requestHash } from './lib/state.mjs';
import { snapshot, restore, loadedToken } from './lib/snapshots.mjs';
import { init, createTask, enroll, openLane, ingest, recordTests, candidates, diff, discuss, decide, combine } from './lib/commands.mjs';
import { publish } from './lib/publish.mjs';

export async function selftest() {
  const heddleVersion = (await run(process.env.HEDDLE_BIN || 'heddle', ['--version'])).stdout.toString().trim();
  const gitVersion = (await run('git', ['--version'])).stdout.toString().trim();
  return { heddleVersion, gitVersion, ok: /^heddle 0\.30\.0\b/.test(heddleVersion) && /git version 2\.(?:4[5-9]|[5-9][0-9])\./.test(gitVersion) };
}

try {
  const cmd = process.argv[2];
  const mutating = { init, 'task.create': createTask, 'agent.enroll': enroll, 'lane.open': openLane, ingest, 'tests.record': recordTests, combine, discuss, decide, publish };
  if (![...Object.keys(mutating), 'selftest', 'snapshot', 'restore', 'loaded', 'candidates', 'diff', 'why'].includes(cmd)) throw new Rejection('unknown_command', 'Unknown engine command');
  const chunks = []; let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > (cmd === 'restore' ? 256 * 1024 * 1024 : 1024 * 1024)) throw new Rejection('body_too_large', 'Engine input exceeds the command limit');
    chunks.push(chunk);
  }
  const input = Buffer.concat(chunks);
  let result;
  if (cmd === 'restore') result = await restore(input);
  else {
    let request; try { request = JSON.parse(input.length ? input : '{}'); } catch { throw new Rejection('invalid_json', 'Expected a JSON object'); }
    if (!request || Array.isArray(request) || typeof request !== 'object') throw new Rejection('invalid_json', 'Expected a JSON object');
    if (cmd === 'selftest') result = await selftest();
    else if (cmd === 'loaded') result = { loaded: await loadedToken() };
    else if (cmd === 'snapshot') await snapshot();
    else {
      const state = await load();
      if (cmd !== 'init' && !state.project) throw new Rejection('not_initialized', 'Initialize the project first');
      if (mutating[cmd]) {
        if (typeof request.opId !== 'string' || !request.opId || request.opId.length > 200) throw new Rejection('invalid_op_id', 'Every mutating command requires opId');
        const recorded = state.operations[request.opId];
        const fingerprint = requestHash(request);
        const publicationBinding = state.publicationRequests?.[request.opId];
        if (publicationBinding && (cmd !== 'publish' || publicationBinding !== fingerprint)) throw new Rejection('op_id_conflict', 'opId is bound to an interrupted publication');
        if (recorded && (recorded.command !== cmd || recorded.requestHash !== fingerprint)) throw new Rejection('op_id_conflict', 'opId is already recorded with different or unbound input');
        if (recorded) result = recorded.result;
        else {
          if (state.pendingPublication && cmd !== 'publish') throw new Rejection('publication_pending', 'Recover the pending publication before another mutation');
          result = await mutating[cmd](state, request);
          await save(state, { opId: request.opId, command: cmd, requestHash: fingerprint, result });
        }
      } else if (cmd === 'candidates') result = candidates(state, request.task);
      else if (cmd === 'diff') result = await diff(state, request);
      else if (cmd === 'why') {
        const narrative = state.narratives[request.sha];
        if (!narrative) throw new Rejection('unknown_commit', 'No narrative for this commit');
        result = { narrative };
      }
    }
  }
  if (cmd !== 'snapshot') process.stdout.write(JSON.stringify(result) + '\n');
} catch (error) {
  if (error.safeMessage) process.stderr.write(error.safeMessage + '\n');
  const locations = [];
  for (const frame of error.stack?.split('\n').slice(1) || []) {
    const location = /engine\/(?:lib\/|test\/)?[a-z-]+\.mjs:\d+:\d+/.exec(frame)?.[0];
    if (location) { locations.push(location); process.stderr.write(location + '\n'); }
  }
  // A crash names only its fixed reason code and the engine frames that led to it, so operators can see which step failed.
  const detail = error instanceof Rejection ? {} : { ...(error.reason ? { reason: error.reason } : {}), ...(locations.length ? { at: locations.slice(0, 3) } : {}) };
  process.stdout.write(JSON.stringify({ error: { code: error instanceof Rejection ? error.code : 'engine_failure', message: error instanceof Rejection ? error.message : 'Engine operation failed', ...detail } }) + '\n');
  process.exitCode = error instanceof Rejection ? 2 : 1;
}
