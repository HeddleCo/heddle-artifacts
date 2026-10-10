// SPDX-License-Identifier: Apache-2.0
import { readdir, rm, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { run, git, gitAuth, remote, Rejection } from './process.mjs';
import { exportRoot } from './state.mjs';

export function forkRemote(canonical, project, task, agent) {
  const name = `${project}--${task}--${agent}`;
  const index = canonical.lastIndexOf('/');
  return canonical.slice(0, index + 1) + name + (canonical.endsWith('.git') ? '.git' : '');
}

export async function fetchCommits(source, shas) {
  remote(source);
  if (shas.some(sha => !/^[0-9a-f]{40}$/.test(sha))) throw new Rejection('invalid_sha', 'Expected a complete SHA-1 commit id');
  await git(exportRoot, ['fetch', '--no-tags', '--no-write-fetch-head', source, ...new Set(shas)], { env: gitAuth(source) });
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
  const result = await run('git', ['--git-dir', exportRoot, 'merge-tree', '--write-tree', '--name-only', '--merge-base', base, a, b], { allowFailure: true });
  if (result.code === 0) return [];
  if (result.code !== 1) throw new Error('Conflict preview failed');
  return result.stdout.toString().split('\n\n')[0].split('\n').slice(1).filter(Boolean);
}

export async function note(sha, narrative, at) {
  await git(exportRoot, ['notes', '--ref=heddle-why', 'add', '-f', '-F', '-', sha], {
    input: narrative + '\n', env: fixedIdentity(at),
  });
}

export function fixedIdentity(at = '2026-10-10T12:00:00Z') {
  return { GIT_AUTHOR_NAME: 'Heddle engine', GIT_AUTHOR_EMAIL: 'engine@heddle-artifacts.local', GIT_COMMITTER_NAME: 'Heddle engine', GIT_COMMITTER_EMAIL: 'engine@heddle-artifacts.local', GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at };
}

export async function diffstat(base, sha) {
  const rows = (await git(exportRoot, ['diff', '--numstat', base, sha, '--'])).split('\n').filter(Boolean);
  return { files: rows.length, insertions: rows.reduce((sum, row) => sum + (Number(row.split('\t')[0]) || 0), 0), deletions: rows.reduce((sum, row) => sum + (Number(row.split('\t')[1]) || 0), 0) };
}
