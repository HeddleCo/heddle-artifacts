// SPDX-License-Identifier: Apache-2.0
import { readdir, rm, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { run, git, gitAuth, remote, Rejection } from './process.mjs';
import { exportRoot, actorEmail } from './state.mjs';

export function forkRemote(canonical, project, task, agent) {
  const full = `${project}--${task}--${agent}`;
  // Keep byte-for-byte parity with worker/artifacts.ts and its Artifacts limit.
  const name = full.length <= 63 ? full : `${full.slice(0, 46)}-${createHash('sha256').update(full).digest('hex').slice(0, 16)}`;
  const index = canonical.lastIndexOf('/');
  return canonical.slice(0, index + 1) + name + (canonical.endsWith('.git') ? '.git' : '');
}

export async function fetchCommits(source, shas) {
  remote(source);
  if (shas.some(sha => !/^[0-9a-f]{40}$/.test(sha))) throw new Rejection('invalid_sha', 'Expected a complete SHA-1 commit id');
  await git(exportRoot, ['fetch', '--no-tags', '--no-write-fetch-head', source, ...new Set(shas)], { env: gitAuth(source), protocol: 2 });
  for (const sha of shas) if (await git(exportRoot, ['cat-file', '-t', sha]) !== 'commit') throw new Rejection('invalid_commit', 'Push must refer to a commit');
}

export async function materialize(sha, checkout) {
  const paths = (await run('git', ['--git-dir', exportRoot, 'ls-tree', '-rz', '--name-only', sha])).stdout.toString().split('\0').filter(Boolean);
  if (paths.some(path => path.split('/').includes('.heddle') || path.split('/').includes('.git'))) throw new Rejection('invalid_tree', 'Source tree cannot replace repository metadata');
  await mkdir(checkout, { recursive: true });
  for (const name of await readdir(checkout)) if (name !== '.heddle') await rm(join(checkout, name), { recursive: true, force: true });
  const archive = (await run('git', ['--git-dir', exportRoot, 'archive', sha], { maxBytes: 64 * 1024 * 1024 })).stdout;
  await run('tar', ['--no-same-owner', '-xf', '-', '-C', checkout], { input: archive, maxBytes: 1024 * 1024 });
}

export async function conflictPaths(base, a, b) {
  return (await mergeTree(a, b, base)).conflicts;
}

/** Merge two commits in the engine's object store without a worktree or ref change. */
export async function mergeTree(a, b, base) {
  const result = await run('git', ['--git-dir', exportRoot, 'merge-tree', '--write-tree', '--name-only', ...(base ? ['--merge-base', base] : []), a, b], { allowFailure: true });
  if (result.code !== 0 && result.code !== 1) throw new Error('Merge preview failed');
  const [head] = result.stdout.toString().split('\n\n'), [tree, ...paths] = head.split('\n');
  if (!/^[0-9a-f]{40}$/.test(tree)) throw new Error('Merge preview returned no tree');
  return { tree, conflicts: result.code === 0 ? [] : [...new Set(paths.filter(Boolean))] };
}

export async function note(sha, narrative, at) {
  await git(exportRoot, ['notes', '--ref=heddle-why', 'add', '-f', '-F', '-', sha], {
    input: narrative + '\n', env: fixedIdentity(at),
  });
}

export function fixedIdentity(at = '2026-10-10T12:00:00Z') {
  const address = actorEmail({ id: 'engine' }, {});
  return { GIT_AUTHOR_NAME: 'Heddle engine', GIT_AUTHOR_EMAIL: address, GIT_COMMITTER_NAME: 'Heddle engine', GIT_COMMITTER_EMAIL: address, GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at };
}

export async function diffstat(base, sha) {
  const rows = (await git(exportRoot, ['diff', '--numstat', base, sha, '--'])).split('\n').filter(Boolean);
  return { files: rows.length, insertions: rows.reduce((sum, row) => sum + (Number(row.split('\t')[0]) || 0), 0), deletions: rows.reduce((sum, row) => sum + (Number(row.split('\t')[1]) || 0), 0) };
}
