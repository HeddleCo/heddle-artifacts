// SPDX-License-Identifier: Apache-2.0
// exec stdout has unknown length. R2 put() requires a known-length stream, so
// upload bounded 5 MiB parts instead of buffering the entire engine snapshot.
export async function streamSnapshot(bucket: R2Bucket, key: string, stream: ReadableStream<Uint8Array>): Promise<void> {
  const size = 5 * 1024 * 1024, reader = stream.getReader();
  let buffer = new Uint8Array(size), used = 0, upload: R2MultipartUpload | undefined;
  const parts: R2UploadedPart[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      let at = 0;
      while (at < value.byteLength) {
        const take = Math.min(size - used, value.byteLength - at); buffer.set(value.subarray(at, at + take), used); used += take; at += take;
        if (used === size) {
          upload ??= await bucket.createMultipartUpload(key);
          parts.push(await upload.uploadPart(parts.length + 1, buffer));
          buffer = new Uint8Array(size); used = 0;
        }
      }
    }
    if (upload) { if (used) parts.push(await upload.uploadPart(parts.length + 1, buffer.subarray(0, used))); await upload.complete(parts); }
    else { if (!used) throw new Error('empty_snapshot'); await bucket.put(key, buffer.subarray(0, used)); }
  } catch (error) { if (upload) await upload.abort(); await reader.cancel().catch(() => {}); throw error; }
}
