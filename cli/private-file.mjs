// SPDX-License-Identifier: Apache-2.0
import { chmod, writeFile } from 'node:fs/promises';
/** Write a file only its owner can read. `mode` applies only when a file is created, so an existing file's mode is set explicitly too. */
export async function writePrivate(file, text) {
  await writeFile(file, text, { mode: 0o600 });
  await chmod(file, 0o600);
}
