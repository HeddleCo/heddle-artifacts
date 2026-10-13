// SPDX-License-Identifier: Apache-2.0
// Fetches from Artifacts use Git protocol v2: its v1 upload-pack answers some multi-ack negotiations with a
// malformed reply ("protocol error: bad band"). Pushes stay on v1, the only push protocol Artifacts accepts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

test('engine fetches speak protocol v2 and pushes stay on v1', async () => {
  const root = await mkdtemp(join(process.env.TMPDIR || tmpdir(), 'engine-git-protocol-'));
  const previous = { PATH: process.env.PATH, ENGINE_STATE_DIR: process.env.ENGINE_STATE_DIR };
  try {
    // A git shim on PATH records every invocation's argv, then runs the real git.
    const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim(), bin = join(root, 'bin'), log = join(root, 'git.log');
    await mkdir(bin);
    await writeFile(join(bin, 'git'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nexec '${realGit}' "$@"\n`); await chmod(join(bin, 'git'), 0o755);
    process.env.PATH = `${bin}:${previous.PATH}`; process.env.ENGINE_STATE_DIR = join(root, 'state');
    const { git, gitAuth } = await import('../../engine/lib/process.mjs');
    const { fetchCommits } = await import('../../engine/lib/git.mjs');
    const { exportRoot } = await import('../../engine/lib/state.mjs');
    const source = join(root, 'fork.git'), work = join(root, 'work');
    execFileSync(realGit, ['init', '-q', '-b', 'main', work]);
    await writeFile(join(work, 'a.txt'), 'a\n');
    execFileSync(realGit, ['-C', work, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qam', 'a', '--allow-empty']);
    execFileSync(realGit, ['-C', work, 'add', '.']); execFileSync(realGit, ['-C', work, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'b']);
    execFileSync(realGit, ['clone', '-q', '--bare', work, source]);
    const sha = execFileSync(realGit, ['-C', work, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    await mkdir(process.env.ENGINE_STATE_DIR, { recursive: true }); execFileSync(realGit, ['init', '-q', '--bare', exportRoot]);
    await writeFile(log, '');
    await fetchCommits(`file://${source}`, [sha]);
    await git(exportRoot, ['push', `file://${source}`, `${sha}:refs/heads/pushed`], { env: gitAuth(`file://${source}`, true) });
    const calls = (await readFile(log, 'utf8')).trim().split('\n');
    assert.ok(calls.some(c => c.startsWith('-c protocol.version=2 fetch ')), calls.join('\n'));
    assert.ok(calls.some(c => c.startsWith('-c protocol.version=1 push ')), calls.join('\n'));
    assert.ok(!calls.some(c => c.includes(' fetch ') && c.includes('protocol.version=1')), 'no fetch uses protocol v1');
    await assert.rejects(git(root, ['status'], { protocol: 3 }), /protocol must be 1 or 2/);
  } finally {
    process.env.PATH = previous.PATH;
    if (previous.ENGINE_STATE_DIR === undefined) delete process.env.ENGINE_STATE_DIR; else process.env.ENGINE_STATE_DIR = previous.ENGINE_STATE_DIR;
    await rm(root, { recursive: true, force: true });
  }
});
