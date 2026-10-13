// SPDX-License-Identifier: Apache-2.0
// Engine child-process failures carry a fixed reason code, never argv, env or stderr text.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { failureReason, git, run } from '../../engine/lib/process.mjs';

const fail = stderr => ({ timedOut: false, overflow: false, stderr: Buffer.from(stderr) });

test('git failures are classified by subcommand and cause', () => {
  const push = ['-c', 'protocol.version=1', 'push', 'https://acct.artifacts.cloudflare.net/git/ns/repo.git', 'refs/heads/x:refs/heads/x'];
  assert.equal(failureReason('git', push, fail("fatal: could not read Username for 'https://acct.artifacts.cloudflare.net': No such device or address")), 'git_push_auth');
  assert.equal(failureReason('git', push, fail("fatal: unable to access 'https://h/': The requested URL returned error: 403")), 'git_push_auth');
  assert.equal(failureReason('git', push, fail(' ! [remote rejected] x -> x (pre-receive hook declined)')), 'git_push_rejected');
  assert.equal(failureReason('git', push, fail("fatal: unable to access 'https://h/': The requested URL returned error: 502")), 'git_push_server_error');
  const fetch = ['fetch', '--no-tags', '--no-write-fetch-head', 'https://h/fork.git', 'a'.repeat(40)];
  assert.equal(failureReason('git', fetch, fail('fatal: remote error: upload-pack: not our ref aaaa')), 'git_fetch_not_our_ref');
  assert.equal(failureReason('git', fetch, fail("remote: Repository not found.\nfatal: repository 'https://h/fork.git/' not found")), 'git_fetch_not_found');
  assert.equal(failureReason('git', fetch, fail('fatal: unable to access: Could not resolve host: h')), 'git_fetch_network');
  assert.equal(failureReason('git', ['--git-dir', '/state/export.git', 'ls-tree', '-rz', 'abc'], fail('fatal: not a tree object')), 'git_ls_tree_failed');
  assert.equal(failureReason('git', fetch, { timedOut: true, overflow: false, stderr: Buffer.alloc(0) }), 'git_fetch_timeout');
  assert.equal(failureReason('heddle', ['--json', 'agent', 'capture', '--lease', 'l', '-m', 'Subject'], fail('error: anything')), 'heddle_agent_capture_failed');
  assert.equal(failureReason('tar', ['--no-same-owner', '-xf', '-'], { timedOut: false, overflow: true, stderr: Buffer.alloc(0) }), 'tar_output_limit');
  // Project-controlled words never become part of the code.
  assert.equal(failureReason('git', ['show', '-s', '--format=%s', 'Bearer'], fail('x')), 'git_show_failed');
});

test('a real failing git push reports its reason without echoing stderr', async () => {
  const dir = await mkdtemp(join(process.env.TMPDIR || tmpdir(), 'engine-failure-'));
  try {
    await run('git', ['init', '-q', '--bare', join(dir, 'source.git')]);
    // An http remote nobody listens on: git prints the URL, including any embedded secret, to stderr.
    const error = await git(join(dir, 'source.git'), ['push', 'http://127.0.0.1:9/secret-path-token.git', 'HEAD:refs/heads/x'], { env: { GIT_TERMINAL_PROMPT: '0' } }).then(() => null, e => e);
    assert.ok(error, 'push must fail');
    assert.match(error.reason, /^git_push_[a-z_]+$/);
    assert.equal(error.safeMessage, `${error.message}: ${error.reason}`);
    assert.doesNotMatch(`${error.message} ${error.safeMessage} ${error.reason}`, /secret-path-token|127\.0\.0\.1/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
