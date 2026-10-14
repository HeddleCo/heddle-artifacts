// SPDX-License-Identifier: Apache-2.0
import { open } from 'node:fs/promises';
/** Restrict the file before truncating or writing any private contents. */
export async function writePrivate(file, text) {
  const handle = await open(file, 'a', 0o600);
  try {
    await handle.chmod(0o600);
    await handle.truncate(0);
    await handle.writeFile(text);
  } finally { await handle.close(); }
}
