// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { run, git, Rejection } from './process.mjs';
import { repoRoot, exportRoot, heddle, ENGINE } from './state.mjs';
import { fixedIdentity } from './git.mjs';

// G3 named fallback: stock 0.30.0's squashed child export can reject one ref.
// Heddle still performs the native land; Git mirrors its tree with fixed dates.
export async function exportProjection(state, destination = exportRoot, repository = repoRoot) {
  const temp = await mkdtemp(join(process.env.TMPDIR || '/tmp', 'heddle-projection-'));
  try {
    const native = join(temp, 'native.git');
    const home = join(dirname(repository), 'agents', ENGINE.id, 'home');
    const exported = await heddle(['bridge', 'git', 'export', '--destination', native], repository, ENGINE, { allowFailure: true, raw: true,
      env: { HEDDLE_HOME: home, HEDDLE_CONFIG: join(home, 'config.toml') } });
    if (exported.code !== 0) {
      let error; try { error = JSON.parse(exported.stderr); } catch {}
      if (exported.code !== 74 || !/^exported \d+ refs?, \d+ diverged \(concurrent git-side update\):/.test(error?.error || '')) throw new Error('Native Git export failed');
    }
    const nativeSha = await git(native, ['rev-parse', 'main']);
    const nativeTree = await git(native, ['rev-parse', 'main^{tree}']);
    const nativeMessage = await git(native, ['show', '-s', '--format=%B', 'main']);
    await git(destination, ['fetch', '--no-tags', '--no-write-fetch-head', native,
      '+refs/heads/main:refs/heddle-native/main', '+refs/notes/heddle:refs/notes/heddle']);
    if (!state.projection) {
      await git(destination, ['update-ref', 'refs/heads/main', nativeSha]);
      return { sha: nativeSha, tree: nativeTree, message: nativeMessage };
    }
    const pin = state.projection;
    if (nativeTree !== pin.treeSha) throw new Rejection('projection_tree_drift', 'Native landed tree differs from the export pin');
    const at = `@${Math.floor(new Date(pin.at).getTime() / 1000)} +0000`;
    const env = { ...fixedIdentity(at), GIT_AUTHOR_NAME: pin.author, GIT_AUTHOR_EMAIL: pin.email, GIT_COMMITTER_NAME: pin.author, GIT_COMMITTER_EMAIL: pin.email };
    const sha = await git(destination, ['commit-tree', nativeTree, '-p', pin.parentSha], { input: pin.message + '\n', env });
    await git(destination, ['update-ref', 'refs/heads/main', sha]);
    return { sha, tree: nativeTree, message: pin.message };
  } finally { await rm(temp, { recursive: true, force: true }); }
}
