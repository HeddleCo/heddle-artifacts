// SPDX-License-Identifier: Apache-2.0
// Verifies only the explicitly exported public evidence; never reads private keys.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash, createPublicKey, verify } from 'node:crypto';

const root = resolve(process.argv[2] || '../genuine-v2/evidence');
const json = async name => JSON.parse(await readFile(join(root, name), 'utf8'));
const result = await json('result.json');
const view = await json('candidate-view.json');
const review = await json('native-review.json');
const turn = await json('review-turn.json');
const why = await json('why.json');
const approval = await json('operator-approval.json');
const directory = await json('published-agent-directory.json');
const digest = value => createHash('sha256').update(value).digest('hex');
assert.equal(approval.manifestSha256, digest(await readFile(join(root, 'trusted-manifest.json'))));
assert.deepEqual(result.pushed, review.sourceShas);
assert.equal(turn.body, JSON.stringify(review));
assert.equal(turn.author, 'native-reviewer');
assert.equal(turn.kind, 'reviewer');
assert.equal(directory.find(agent => agent.id === turn.author)?.publicKey, turn.signedBy);
assert.equal(result.mainTree, result.chosenTree);
assert.equal(why.verify.sha, result.main);
for (const name of ['exportRoundTrip', 'treeMatch', 'fsck']) assert.equal(why.verify[name], true);
const proofs = why.narrative.split('\n').filter(line => line.startsWith('Turn proof: ') || line.startsWith('Decision proof: ')).map(line => JSON.parse(line.slice(line.indexOf(': ') + 2)));
let reviewerProof;
for (const record of proofs) {
  const key = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(record.publicKey, 'hex')]), type: 'spki', format: 'der' });
  assert.equal(verify(null, Buffer.from(record.payload), key, Buffer.from(record.signature, 'hex')), true);
  const payload = JSON.parse(record.payload);
  assert.equal(payload.domain, 'heddle-artifacts-collaboration-v1');
  assert.equal(digest(Buffer.from(payload.nativeEnvelope, 'base64')), payload.envelopeSha256);
  if (payload.operationId === turn.id) {
    assert.equal(record.publicKey, turn.signedBy);
    assert.equal(payload.author, turn.author);
    assert.equal(payload.body, turn.body);
    reviewerProof = { operationId: payload.operationId, publicKey: record.publicKey, envelopeSha256: payload.envelopeSha256 };
  }
}
assert.ok(reviewerProof, 'Exact independent reviewer operation has a valid attestation');
for (const candidate of view.candidates) {
  assert.equal(directory.find(agent => agent.id === candidate.agent)?.publicKey, candidate.signedBy);
  assert.equal(candidate.sourceSha, result.pushed[candidate.agent]);
  assert.equal(candidate.sourceSha, approval.candidates[candidate.agent].sourceSha);
  assert.equal(candidate.treeSha, approval.candidates[candidate.agent].treeSha);
  assert.equal(candidate.tests.status, 'pass');
}
assert.match(result.decision.rationale, /^SCRIPTED TEST CHOICE/);
const evidence = { verifiedAt: new Date().toISOString(), passed: true, verifiedAttestations: proofs.length, reviewerProof,
  checks: ['exact review body and native operation ID', 'Ed25519 signatures on exported native-envelope attestations', 'SHA-256 of signed native envelopes', 'public reviewer key matches signed turn', 'exact original Git OID and tree linkage', 'manifest file digest', 'candidate test status', 'selected tree equality', 'SHA-bound publication verification', 'scripted choice explicitly labeled'],
  limitation: 'Custodial gateway attestations on stock native operations; not a model-provider signature or a claim that stock discussion objects are inherently signed.' };
// Read-only by default so rechecking a sealed evidence packet preserves hashes.
if (process.argv.includes('--write')) await writeFile(join(root, 'public-proof-verification.json'), JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
console.log(`GENUINE PUBLIC PROOF PASS: ${proofs.length} Ed25519 native-envelope attestations; exact reviewer body and Git/native linkage.`);
