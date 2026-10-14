// SPDX-License-Identifier: Apache-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { actorEmail, actorEnv, defaultEmailDomain } from '../../engine/lib/state.mjs';
import { fixedIdentity } from '../../engine/lib/git.mjs';
import { run } from '../../engine/lib/process.mjs';
const engine = fileURLToPath(new URL('../../engine/engine.mjs', import.meta.url));
const gwen = { id: 'gwen', kind: 'agent', displayName: 'Gwen' };
const luke = { id: 'luke', kind: 'human', displayName: 'Luke', email: 'luke@heddle.sh', sponsor: true };

test('new agent and reviewer addresses use the explicit sponsor, dropping any existing plus tag', () => {
  assert.equal(actorEmail(gwen, { sponsor: luke }), 'luke+gwen@heddle.sh');
  assert.equal(actorEmail(gwen, { sponsor: { ...luke, email: 'luke+x@heddle.sh' } }), 'luke+gwen@heddle.sh');
  assert.equal(actorEmail({ ...gwen, id: 'reviewer', kind: 'reviewer' }, { sponsor: luke }), 'luke+reviewer@heddle.sh');
  assert.equal(actorEmail({ ...gwen, email: 'ignored@example.com' }, { sponsor: luke }), 'luke+gwen@heddle.sh');
});
test('new identities without real addresses use a configurable noreply domain; human emails stay real', () => {
  assert.equal(defaultEmailDomain(), 'noreply.heddle.sh');
  assert.equal(actorEmail(gwen, {}), 'gwen@noreply.heddle.sh');
  assert.equal(actorEmail(gwen, { domain: 'noreply.operator.example' }), 'gwen@noreply.operator.example');
  assert.equal(actorEmail({ id: 'luke', kind: 'human' }, { sponsor: luke }), 'luke@noreply.heddle.sh');
  assert.equal(actorEmail(luke, {}), 'luke@heddle.sh');
  assert.equal(fixedIdentity().GIT_AUTHOR_EMAIL, 'engine@noreply.heddle.sh');
});
test('resolving a stored or legacy identity never recomputes its address', () => {
  const stored = { ...gwen, address: 'gwen@noreply.heddle.sh' };
  assert.equal(actorEmail(stored, { sponsor: luke, domain: 'different.example' }), stored.address);
  assert.equal(actorEnv(stored).HEDDLE_PRINCIPAL_EMAIL, stored.address);
  assert.equal(actorEmail(gwen), 'gwen@heddle-artifacts.local');
  assert.equal(actorEmail({ ...gwen, email: 'ignored@example.com' }), 'gwen@heddle-artifacts.local');
  assert.equal(actorEmail({ id: 'legacy', kind: 'human' }), 'legacy@heddle-artifacts.local');
  assert.equal(actorEmail(luke), luke.email);
});
test('invalid default domains are rejected clearly, including empty values and line breaks', () => {
  for (const value of ['', 'localhost', '.example.com', 'example.com.', 'a..b', '-a.example', 'a-.example', 'a_b.example',
    'example.com\n', 'example.com\r\n', ' example.com', 'a@example.com', 'https://example.com', 'example.com:443',
    'a/b.example', 'a'.repeat(64) + '.example', 'a.'.repeat(127) + 'a', null, 123]) {
    assert.throws(() => defaultEmailDomain(value), { code: 'invalid_actor_email_domain', message: 'ACTOR_EMAIL_DOMAIN must be a hostname with at least one dot' }, String(value));
    assert.throws(() => actorEmail(gwen, { domain: value }), { code: 'invalid_actor_email_domain' }, String(value));
  }
  assert.equal(defaultEmailDomain('Mail.Sub-domain.Example'), 'Mail.Sub-domain.Example');
});
async function fixture(t, agents = {}) {
  const root = await mkdtemp(join(tmpdir(), 'actor-email-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'state'));
  const file = join(root, 'state/engine.json');
  await writeFile(file, JSON.stringify({ format: 1, generation: 0, root: join(root, 'state'), project: 'fixture', agents }));
  let op = 0;
  return { file, root, stored: async () => JSON.parse(await readFile(file, 'utf8')), async enroll(agent, domain = 'noreply.heddle.sh') {
    const result = await run(process.execPath, [engine, 'agent.enroll'], { env: { ENGINE_STATE_DIR: join(root, 'state'), ACTOR_EMAIL_DOMAIN: domain },
      input: JSON.stringify({ opId: `enroll-${++op}`, agent }), allowFailure: true });
    return { code: result.code, ...JSON.parse(result.stdout) };
  } };
}
test('enrollment freezes the address before a sponsor, uses only the explicit sponsor, and persists the designation', async t => {
  const f = await fixture(t);
  assert.equal((await f.enroll({ ...luke, sponsor: undefined })).code, 0);
  assert.equal((await f.enroll(gwen)).address, 'gwen@noreply.heddle.sh', 'a human email alone is not a sponsor');
  assert.equal((await f.enroll(luke)).code, 0, 'an existing human can become the sponsor');
  const before = (await f.stored()).agents.gwen;
  assert.deepEqual(await f.enroll(gwen, 'changed.example'), { code: 0, address: before.address, publicKey: before.publicKey });
  assert.equal((await f.enroll({ ...gwen, id: 'reviewer', kind: 'reviewer' })).address, 'luke+reviewer@heddle.sh');
  assert.equal((await f.stored()).agents.luke.sponsor, true);
  const saved = await readFile(f.file, 'utf8');
  assert.equal((await f.enroll({ ...luke, id: 'other' })).error.code, 'sponsor_exists');
  assert.equal((await f.enroll({ ...luke, id: 'missing-email', email: undefined })).error.code, 'invalid_sponsor');
  assert.equal((await f.enroll({ ...gwen, sponsor: true, email: 'agent@example.com' })).error.code, 'invalid_sponsor');
  assert.equal(await readFile(f.file, 'utf8'), saved, 'invalid sponsor registrations leave the manifest unchanged');
});
test('enrollment retains old records without addresses and rejects a bad deployment setting before writes', async t => {
  const legacy = { ...gwen, publicKey: 'a'.repeat(64) };
  const f = await fixture(t, { gwen: legacy });
  assert.deepEqual(await f.enroll(gwen), { code: 0, publicKey: legacy.publicKey });
  assert.deepEqual((await f.stored()).agents.gwen, legacy);
  const saved = await readFile(f.file, 'utf8');
  const bad = await f.enroll({ ...gwen, id: 'new' }, 'localhost');
  assert.equal(bad.code, 2); assert.equal(bad.error.code, 'invalid_actor_email_domain');
  assert.match(bad.error.message, /ACTOR_EMAIL_DOMAIN/);
  assert.equal(await readFile(f.file, 'utf8'), saved);
  await assert.rejects(stat(join(f.root, 'state/agents/new')), { code: 'ENOENT' });
});
