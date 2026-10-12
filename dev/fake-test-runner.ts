// SPDX-License-Identifier: Apache-2.0
// Contract fixture only; no candidate code executes and no production evidence.
import type { SandboxInput, SandboxRun, TestRunner } from '../worker/isolated-tests';
export class FakeTestRunner {
  inputs: Array<{ id: string; input: SandboxInput }> = [];
  destroyed: string[] = [];
  output = '# pass 14\n# fail 0\n';
  failure: SandboxRun['failure'];
  installExitCode = 0;
  testExitCode = 0;
  delayMs = 0;
  reject = false;
  get(id: string): TestRunner {
    return {
      run: async input => {
        this.inputs.push({ id, input: structuredClone(input) });
        if (this.delayMs) await new Promise(r => setTimeout(r, this.delayMs));
        if (this.reject) throw new Error('fake sandbox failure');
        return { sourceSha: input.sourceSha, treeSha: input.treeSha, output: this.output, durationMs: 5,
          installExitCode: this.installExitCode, testExitCode: this.testExitCode, ...(this.failure ? { failure: this.failure } : {}) };
      },
      destroy: async () => { this.destroyed.push(id); },
    };
  }
}
export const fakeTestRunner = new FakeTestRunner();
