// SPDX-License-Identifier: Apache-2.0
import { readFile, readdir } from 'node:fs/promises';
import { createPublicKey, verify } from 'node:crypto';
import { join } from 'node:path';
import { Rejection, run } from './process.mjs';

// Heddle 878fea43 stores named-field MessagePack signature attachments.
// `show` supplies the recomputed content hash, but omits the attachment itself.
// Decode only the stock object format; never alter Heddle's state or notes.
export function decodeMsgpack(buffer) {
  let offset = 0;
  const take = n => { if (offset + n > buffer.length) throw new Error('Truncated attachment'); const b = buffer.subarray(offset, offset + n); offset += n; return b; };
  const number = n => { const b = take(n); return n === 8 ? Number(b.readBigUInt64BE()) : b.readUIntBE(0, n); };
  const string = n => take(n).toString();
  const array = n => Array.from({ length: n }, read);
  const map = n => { const result = Object.create(null); for (let i = 0; i < n; i++) result[read()] = read(); return result; };
  function read() {
    const tag = number(1);
    if (tag <= 0x7f) return tag;
    if (tag >= 0xe0) return tag - 256;
    if ((tag & 0xe0) === 0xa0) return string(tag & 31);
    if ((tag & 0xf0) === 0x90) return array(tag & 15);
    if ((tag & 0xf0) === 0x80) return map(tag & 15);
    switch (tag) {
      case 0xc0: return null;
      case 0xc2: return false;
      case 0xc3: return true;
      case 0xc4: return take(number(1));
      case 0xc5: return take(number(2));
      case 0xc6: return take(number(4));
      case 0xca: return take(4).readFloatBE();
      case 0xcb: return take(8).readDoubleBE();
      case 0xcc: return number(1);
      case 0xcd: return number(2);
      case 0xce: return number(4);
      case 0xcf: return number(8);
      case 0xd0: return take(1).readInt8();
      case 0xd1: return take(2).readInt16BE();
      case 0xd2: return take(4).readInt32BE();
      case 0xd3: return Number(take(8).readBigInt64BE());
      case 0xd9: return string(number(1));
      case 0xda: return string(number(2));
      case 0xdb: return string(number(4));
      case 0xdc: return array(number(2));
      case 0xdd: return array(number(4));
      case 0xde: return map(number(2));
      case 0xdf: return map(number(4));
      default: throw new Error('Unsupported attachment encoding');
    }
  }
  const result = read();
  if (offset !== buffer.length) throw new Error('Trailing attachment data');
  return result;
}

async function* attachments(heddleDir, stateId, contentHash) {
  const dir = join(heddleDir, 'objects', 'state-attachments', stateId);
  for (const name of await readdir(dir).catch(() => [])) if (name.endsWith('.attachment')) yield decodeMsgpack(await readFile(join(dir, name)));
  // Captures in 0.30.0 publish attachments directly in snapshot packs (LMPK v4).
  const packs = join(heddleDir, 'packs');
  for (const name of await readdir(packs).catch(() => [])) {
    if (!name.endsWith('.pack')) continue;
    const pack = await readFile(join(packs, name));
    if (pack.length > 64 * 1024 * 1024 || pack.subarray(0, 4).toString() !== 'LMPK' || pack.readUInt32BE(4) !== 4) throw new Error('Unsupported signature pack');
    let offset = 16;
    const varint = (firstBits, first) => {
      let value = first & ((1 << firstBits) - 1), shift = firstBits, byte = first;
      while (byte & 128) {
        if (shift > 63 || offset >= pack.length - 32) throw new Error('Invalid pack varint');
        byte = pack[offset++]; value += (byte & 127) * 2 ** shift; shift += 7;
      }
      return value;
    };
    // Compact frames can index several logical objects at one physical offset.
    // The container count is logical; walk physical records to the checksum.
    while (offset < pack.length - 32) {
      offset += 33; // tagged object identity
      const header = pack[offset++], type = (header >> 4) & 7;
      const size = varint(4, header), storedSize = varint(7, pack[offset++]);
      if (type === 4) offset += 33; // tagged delta base, never used for signatures
      if (offset + storedSize > pack.length - 32) throw new Error('Truncated signature pack');
      const stored = pack.subarray(offset, offset + storedSize); offset += storedSize;
      if (type !== 5) continue;
      if (size > 1024 * 1024) throw new Error('Signature attachment exceeds limit');
      const data = size === storedSize ? stored : (await run('zstd', ['-d', '-q', '-c'], { input: stored, maxBytes: 1024 * 1024 })).stdout;
      const attachment = decodeMsgpack(data);
      if (Buffer.from(attachment.state_id).toString('hex') === contentHash) yield attachment;
    }
  }
}

export async function verifyCapture(heddleDir, show, expectedKey) {
  for await (const attachment of attachments(heddleDir, show.state_id_full, show.content_hash)) {
    const signature = attachment.body?.Signature;
    if (!signature || signature.public_key !== expectedKey || signature.algorithm !== 'ed25519') continue;
    const key = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(expectedKey, 'hex')]), type: 'spki', format: 'der' });
    const payload = Buffer.concat([Buffer.from('hd-state-sig-v1\0'), Buffer.from(show.content_hash, 'hex')]);
    if (verify(null, payload, key, Buffer.from(signature.signature, 'hex'))) return signature.public_key;
  }
  throw new Rejection('identity_mismatch', 'Capture has no valid signature from the enrolled agent');
}
