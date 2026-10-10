// SPDX-License-Identifier: Apache-2.0
import { Rejection } from './process.mjs';

export const DIRECTORY_REF = 'refs/heads/heddle/agents';
export const MANIFEST_PATH = '.heddle-publication.json';
const MAIN_REF = 'refs/heads/main';
const fail = message => { throw new Rejection('publication_conflict', message); };

export function exactRefs(tips, expected) {
  for (const [ref, oid] of Object.entries(expected)) if ((tips[ref] || null) !== oid) fail('Publication refs differ from the pinned snapshot');
}

export function leasedPushArgs(remote, updates) {
  return ['push', ...updates.map(({ ref, before }) => `--force-with-lease=${ref}:${before || ''}`),
    remote, ...updates.map(({ ref, oid }) => `${oid}:${ref}`)];
}

// Transport-independent, main-last publication. Auxiliary aliases can be pending;
// the immutable manifest, selected by exact main, is the authoritative snapshot.
// This is deliberately NOT an all-refs-atomic transaction.
export async function orderedPublish({ manifest, directoryOid, readRefs, pushRefs, verifySnapshot }) {
  const auxiliary = [
    { ref: DIRECTORY_REF, oid: directoryOid, before: manifest.directoryBefore },
    ...Object.entries(manifest.refs).map(([ref, value]) => ({ ref, ...value })),
  ];
  const names = [MAIN_REF, ...auxiliary.map(item => item.ref)];
  const checkExact = tips => {
    exactRefs(tips, Object.fromEntries(auxiliary.map(item => [item.ref, item.oid])));
  };
  let tips = await readRefs(names);
  if (tips[MAIN_REF] === manifest.main) {
    // Lost acknowledgement: never repair or rewrite metadata for landed main.
    // A later pending directory may lead main; resolve the original manifest
    // through its retained first-parent history instead of adopting new aliases.
    await verifySnapshot(tips[DIRECTORY_REF]);
    if (tips[DIRECTORY_REF] === directoryOid) checkExact(tips);
    return;
  }
  if (tips[MAIN_REF] !== manifest.expectedMain) fail('Canonical main changed from the expected decision parent');
  for (const item of auxiliary) {
    const actual = tips[item.ref] || null;
    if (actual !== item.oid && actual !== item.before) fail('A pending publication ref changed outside this transaction');
  }
  // Establish the durable, recoverable receipt and all reachable proof objects
  // before exposing ordinary notes/candidate aliases. No rollback of aliases.
  if (tips[DIRECTORY_REF] !== directoryOid) await pushRefs([auxiliary[0]]);
  const updates = auxiliary.slice(1).filter(item => tips[item.ref] !== item.oid);
  if (updates.length) await pushRefs(updates);
  tips = await readRefs(names);
  if (tips[MAIN_REF] !== manifest.expectedMain) fail('Canonical main changed before publication');
  checkExact(tips);
  await verifySnapshot(tips[DIRECTORY_REF]);
  await pushRefs([{ ref: MAIN_REF, oid: manifest.main, before: manifest.expectedMain }]);
  tips = await readRefs(names);
  if (tips[MAIN_REF] !== manifest.main) fail('Canonical main readback did not match the decision');
  checkExact(tips);
  await verifySnapshot(tips[DIRECTORY_REF]);
}
