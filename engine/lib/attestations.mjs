// SPDX-License-Identifier: Apache-2.0
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash, createPublicKey, sign, verify } from 'node:crypto';
import { join } from 'node:path';
import { stateRoot, repoRoot } from './state.mjs';
import { Rejection } from './process.mjs';

// Stock local discussions are unsigned. Preserve and sign their exact native
// bytes as custodial attestations, without changing Heddle's object format.
export async function attestOperation(state, agent, operationId, context) {
  const alphabet = '0123456789abcdefghjkmnpqrstvwxyz';
  const encoded = operationId.replace(/^co-/, '');
  if (encoded.length !== 52 || [...encoded].some(c => !alphabet.includes(c))) throw new Error('Unexpected collaboration operation id');
  let bits = 0, value = 0; const decoded = [];
  for (const char of encoded) {
    value = (value << 5) | alphabet.indexOf(char); bits += 5;
    if (bits >= 8) { bits -= 8; decoded.push((value >> bits) & 255); value &= (1 << bits) - 1; }
  }
  const hex = Buffer.from(decoded).toString('hex');
  const bytes = await readFile(join(repoRoot, '.heddle', 'collaboration', 'ops', hex.slice(0, 2), hex.slice(2) + '.msgpack'));
  const payload = JSON.stringify({ domain: 'heddle-artifacts-collaboration-v1', author: agent.id, operationId,
    nativeEnvelope: bytes.toString('base64'), envelopeSha256: createHash('sha256').update(bytes).digest('hex'), ...context });
  const identity = await readFile(join(stateRoot, 'agents', agent.id, 'home', 'device-identity.toml'), 'utf8');
  const pem = /private_key_pem = '''([\s\S]*?)'''/.exec(identity)?.[1];
  if (!pem) throw new Error('Missing custodial identity');
  const record = { publicKey: agent.publicKey, payload, signature: sign(null, Buffer.from(payload), pem).toString('hex') };
  verifyAttestation(record, agent.publicKey);
  const dir = join(stateRoot, 'attestations');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(join(dir, hex + '.json'), JSON.stringify(record) + '\n', { mode: 0o600 });
  state.attestations ||= {};
  state.attestations[operationId] = record;
  return record.publicKey;
}

export function verifyAttestation(record, expectedKey) {
  const key = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(expectedKey, 'hex')]), type: 'spki', format: 'der' });
  if (record.publicKey !== expectedKey || !verify(null, Buffer.from(record.payload), key, Buffer.from(record.signature, 'hex'))) throw new Rejection('identity_mismatch', 'Collaboration attestation does not match the enrolled identity');
  return record.publicKey;
}

// A detached engine observation does not rewrite the agent's native Capture.
// Its signature binds the measured tests to that Capture, source SHA and tree.
export async function attestTests(context) {
  const { identity } = await import('./state.mjs');
  const publicKey = await identity('_engine');
  const file = await readFile(join(stateRoot, 'agents', '_engine', 'home', 'device-identity.toml'), 'utf8');
  const pem = /private_key_pem = '''([\s\S]*?)'''/.exec(file)?.[1];
  if (!pem) throw new Error('Missing engine identity');
  const payload = JSON.stringify({ domain: 'heddle-artifacts-tests-v1', ...context });
  const proof = { publicKey, payload, signature: sign(null, Buffer.from(payload), pem).toString('hex') };
  verifyAttestation(proof, publicKey);
  return proof;
}
