// SPDX-License-Identifier: Apache-2.0
// Local-only SDK/container smoke fixture. Never imported by the production Worker.
import { DurableObject } from 'cloudflare:workers';
import { Files } from '@cloudflare/sandbox';
import { isolatedTestResult } from '../engine/lib/isolated-tests.mjs';
import { startTestContainer } from '../worker/test-sandbox';
export class SandboxSmoke extends DurableObject {
  async smoke() {
    const container = this.ctx.container;
    if (!container) throw new Error('container unavailable');
    const started = Date.now();
    try {
      startTestContainer(container);
      await container.setInactivityTimeout(30000);
      const files = new Files(container);
      await files.mkdir('/workspace', { recursive: true });
      await files.writeFile('/workspace/package.json', JSON.stringify({ name: 'sandbox-smoke', version: '1.0.0', scripts: { test: 'node --test test.mjs' } }));
      await files.writeFile('/workspace/package-lock.json', JSON.stringify({ name: 'sandbox-smoke', version: '1.0.0', lockfileVersion: 3, packages: { '': { name: 'sandbox-smoke', version: '1.0.0' } } }));
      await files.writeFile('/workspace/test.mjs', "import {test} from 'node:test'; import assert from 'node:assert/strict'; test('real sandbox fixture', () => assert.equal(1 + 1, 2));\n");
      const install = await (await container.exec(['timeout', '120', 'npm', 'ci', '--ignore-scripts'], { cwd: '/workspace', stderr: 'combined' })).output();
      const test = await (await container.exec(['timeout', '30', 'npm', 'test'], { cwd: '/workspace', stderr: 'combined' })).output();
      const output = new TextDecoder().decode(test.stdout);
      return { localFixture: true, sdk: '1.0.0', result: isolatedTestResult({ sourceSha: '0'.repeat(40), output, durationMs: Date.now() - started, installExitCode: install.exitCode, testExitCode: test.exitCode }), output };
    } finally { await container.destroy(); }
  }
}
export default { async fetch(_request: Request, env: { SMOKE: DurableObjectNamespace<SandboxSmoke> }) { return Response.json(await env.SMOKE.getByName(crypto.randomUUID()).smoke()); } };
