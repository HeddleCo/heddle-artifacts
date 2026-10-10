// SPDX-License-Identifier: Apache-2.0
import { it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import type { Env } from '../env';
import { streamSnapshot } from '../snapshot';
it('unknown-length exec stdout uploads through bounded multipart parts and round-trips byte-exactly', async () => {
  const bucket = (env as unknown as Env).STATE, length = 5 * 1024 * 1024 + 12345;
  let position = 0;
  const stream = new ReadableStream<Uint8Array>({ pull(controller) {
    if (position === length) { controller.close(); return; }
    const count = Math.min(65537, length - position), chunk = new Uint8Array(count);
    for (let i = 0; i < count; i++) chunk[i] = (position + i) % 251;
    position += count; controller.enqueue(chunk);
  } });
  const key = `stream-${crypto.randomUUID()}`; await streamSnapshot(bucket, key, stream);
  const object = await bucket.get(key); expect(object?.size).toBe(length);
  const bytes = new Uint8Array(await object!.arrayBuffer());
  for (let i = 0; i < bytes.length; i++) { if (bytes[i] !== i % 251) throw new Error(`Corrupt snapshot byte ${i}`); }
});
it('a failed snapshot stream publishes no partial R2 generation', async () => {
  const bucket = (env as unknown as Env).STATE, key = `failed-${crypto.randomUUID()}`; let written = false;
  const stream = new ReadableStream<Uint8Array>({ pull(controller) {
    if (!written) { written = true; controller.enqueue(new Uint8Array(5 * 1024 * 1024)); }
    else controller.error(new Error('fixture process killed'));
  } });
  await expect(streamSnapshot(bucket, key, stream)).rejects.toThrow('fixture process killed'); expect(await bucket.get(key)).toBeNull();
});
