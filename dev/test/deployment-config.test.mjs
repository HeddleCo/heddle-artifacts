// SPDX-License-Identifier: Apache-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import ts from 'typescript';

const root = new URL('../../', import.meta.url);
test('demo Container build context and compute defaults are bounded', async () => {
  const text = await readFile(new URL('wrangler.jsonc', root), 'utf8');
  const parsed = ts.parseConfigFileTextToJson('wrangler.jsonc', text);
  assert.equal(parsed.error, undefined);
  assert.equal(parsed.config.containers.length, 2);
  const container = parsed.config.containers[0];
  assert.equal(container.image, './engine/Dockerfile.layer');
  assert.equal(container.image_build_context, '.');
  assert.equal(container.max_instances, 1);
  const sandbox = parsed.config.containers[1];
  assert.equal(sandbox.class_name, 'CandidateTestSandbox');
  assert.equal(sandbox.max_instances, 3);
  assert.equal(sandbox.instance_type, 'lite');
  assert.equal(sandbox.image, './sandbox/Dockerfile');
  assert.equal(sandbox.image_build_context, './sandbox');
  assert.deepEqual(parsed.config.migrations[0], { tag: 'v1', new_sqlite_classes: ['ProjectDO', 'HeddleEngine'] });
  assert.deepEqual(parsed.config.migrations[1], { tag: 'v2-isolated-candidate-tests', new_sqlite_classes: ['CandidateTestSandbox'] });
  const pkg = JSON.parse(await readFile(new URL('package.json', root)));
  const dockerfile = await readFile(new URL('sandbox/Dockerfile', root), 'utf8');
  assert.equal(pkg.dependencies['@cloudflare/sandbox'], '1.0.0');
  assert.match(dockerfile, /cloudflare\/sandbox:1\.0\.0/);
  const layer = await readFile(new URL('engine/Dockerfile.layer', root), 'utf8');
  assert.match(layer, /@sha256:085fc19e7bc673d97204ca07e636c95cb51054658e1b0282f349549004e97445/);
  assert.match(layer, /COPY --chown=0:0 engine\//); assert.match(layer, /COPY --chown=0:0 contracts\//); assert.match(layer, /COPY --chown=0:0 demo\//);
  assert.match(layer, /chmod -R go-w/); assert.match(layer, /USER 65532:65532/);
  const source = await readFile(new URL('worker/engine-container.ts', root), 'utf8');
  assert.match(source, /sleepAfter = '5m'/);
  assert.match(source, /setInactivityTimeout\(5 \* 60 \* 1000\)/);
  assert.match(source, /ENGINE_COMMAND_MS = 180000;/);
  assert.match(source, /AbortSignal\.timeout\(ENGINE_COMMAND_MS\)/);
  assert.match(source, /deadline\(Promise\.all\(\[stdout/);
});
test('root Docker context is an exact runtime-source allowlist, excluding private state', async () => {
  const rules = (await readFile(new URL('.dockerignore', root), 'utf8')).split(/\r?\n/).filter(line => line && !line.startsWith('#'));
  assert.equal(rules[0], '**');
  const included = new Set();
  for (let i = 1; i < rules.length; i++) {
    const rule = rules[i];
    assert.match(rule, /^![a-zA-Z0-9/_.-]+\/?$/); // no broad re-inclusion glob
    const path = rule.slice(1); included.add(path);
    const info = await stat(new URL(path, root));
    assert.equal(info.isDirectory(), path.endsWith('/'));
    // Docker exception rules match descendants as well as the exact directory:
    // https://github.com/moby/patternmatcher/blob/v0.6.0/patternmatcher.go#L120
    // Immediately exclude children again, before exact file exceptions.
    if (info.isDirectory()) assert.equal(rules[++i], `${path}**`);
  }
  for (const path of ['engine/engine.mjs', 'engine/lib/trusted-tests.mjs', 'engine/lib/ordered-publication.mjs', 'engine/lib/publication-input.mjs', 'demo/trusted-test-trees.json', 'contracts/types.ts', 'demo/seed-project/package-lock.json']) assert(included.has(path));
  for (const path of ['.git/config', '.dev.vars', '.env', 'engine/.env', 'engine/test/identity.key', 'demo/seed-project/node_modules/', 'demo/seed-project/.npmrc', 'evidence/state/']) assert(!included.has(path));
  // Exercise exactly the deliberately narrow pattern grammar above, including
  // Docker's parent matching. This is not a substitute for the pending build.
  const excluded = path => {
    const segments = path.replace(/\/$/, '').split('/');
    const parents = segments.map((_, i) => segments.slice(0, i + 1).join('/'));
    let result = false;
    for (const rule of rules) {
      const exception = rule.startsWith('!');
      const pattern = (exception ? rule.slice(1) : rule).replace(/\/$/, '');
      if (parents.some(parent => pattern === '**' || (pattern.endsWith('/**')
        ? parent.startsWith(pattern.slice(0, -2)) : parent === pattern))) result = !exception;
    }
    return result;
  };
  for (const path of included) assert.equal(excluded(path), false, path);
  for (const path of ['engine/.env', 'engine/lib/identity.key', 'contracts/.env',
    'demo/seed-project/.npmrc', 'demo/seed-project/src/unreviewed.ts',
    'demo/seed-project/test/private.key', 'demo/evidence/private-state.json']) assert.equal(excluded(path), true, path);
});
