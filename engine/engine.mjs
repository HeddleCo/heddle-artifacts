// SPDX-License-Identifier: Apache-2.0
import { run, Rejection } from './lib/process.mjs';

export async function selftest() {
  const heddleVersion = (await run(process.env.HEDDLE_BIN || 'heddle', ['--version'])).stdout.toString().trim();
  const gitVersion = (await run('git', ['--version'])).stdout.toString().trim();
  return { heddleVersion, gitVersion, ok: /^heddle 0\.30\.0\b/.test(heddleVersion) && /git version 2\.(?:4[5-9]|[5-9][0-9])\./.test(gitVersion) };
}

try {
  if (process.argv[2] !== 'selftest') throw new Rejection('unknown_command', 'Engine command is not implemented yet');
  process.stdout.write(JSON.stringify(await selftest()) + '\n');
} catch (error) {
  process.stdout.write(JSON.stringify({ error: { code: error.code || 'engine_failure', message: error.message } }) + '\n');
  process.exitCode = error instanceof Rejection ? 2 : 1;
}
