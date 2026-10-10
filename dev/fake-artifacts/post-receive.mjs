// SPDX-License-Identifier: Apache-2.0
import { git } from './binding.mjs';
const [eventUrl, namespace, repoName] = process.argv.slice(2);
let input = ''; for await (const b of process.stdin) input += b;
for (const line of input.trim().split('\n')) {
  const [before, after, ref] = line.split(' ');
  const commits = [];
  if (after && after !== '0'.repeat(40)) {
    const raw = await git(['show', '-s', '--format=%H%x00%P%x00%an%x00%ae%x00%cn%x00%ce%x00%aI%x00%B', after], process.cwd());
    const p = raw.split('\0'); commits.push({ id: p[0], parents: p[1].split(' ').filter(Boolean), author: { name: p[2], email: p[3] }, committer: { name: p[4], email: p[5] }, timestamp: p[6], message: p[7].trimEnd(), messageTruncated: false });
  }
  const event = { type: 'cf.artifacts.repo.pushed', source: { type: 'artifacts.repo', namespace, repoName }, payload: { ref, before, after, commits, totalCommitsCount: commits.length, commitsTruncated: false }, metadata: { eventSchemaVersion: 1, eventTimestamp: new Date().toISOString(), accountId: 'local', eventSubscriptionId: 'local' } };
  // Push success does not depend on coordination. The alarm poller recovers missed hooks.
  try { await fetch(eventUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(event), signal: AbortSignal.timeout(1000) }); } catch {}
}
