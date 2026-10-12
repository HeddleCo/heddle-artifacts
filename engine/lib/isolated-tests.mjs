// SPDX-License-Identifier: Apache-2.0
export const TEST_BUDGET_MS = 180000;
export const TEST_OUTPUT_BYTES = 64 * 1024;

// Only parse runner stdout. Candidate-supplied JSON counts are never input.
export function parseTestCounts(output) {
  const text = output.replace(/\x1b\[[0-9;]*m/g, '').replace(/\r/g, '');
  const vitest = [...text.matchAll(/^\s*Tests\s+(.+)$/gm)].at(-1)?.[1];
  const pass = vitest ? /(?:^|\|)\s*(\d+) passed\b/.exec(vitest)?.[1] : [...text.matchAll(/^(?:#|ℹ) pass (\d+)\s*$/gm)].at(-1)?.[1];
  const fail = vitest ? /(?:^|\|)\s*(\d+) failed\b/.exec(vitest)?.[1] : [...text.matchAll(/^(?:#|ℹ) fail (\d+)\s*$/gm)].at(-1)?.[1];
  if (pass === undefined && fail === undefined) return;
  const passed = Number(pass ?? 0), failed = Number(fail ?? 0);
  if (![passed, failed].every(n => Number.isSafeInteger(n) && n >= 0 && n <= 1000000)) return;
  return { passed, failed };
}

export function isolatedTestResult(run) {
  const provenance = run?.fixture ? 'isolated sandbox (local fixture)' : 'isolated sandbox';
  const durationMs = Number.isFinite(run?.durationMs) ? Math.min(TEST_BUDGET_MS, Math.max(0, Math.round(run.durationMs))) : 0;
  const error = summary => ({ status: 'error', passed: 0, failed: 0, summary, durationMs, provenance, sourceSha: run?.sourceSha });
  if (run?.failure === 'timeout' || run?.durationMs >= TEST_BUDGET_MS || [run?.installExitCode, run?.testExitCode].some(c => c === 124 || c === 137)) return error('Isolated sandbox exceeded 180 seconds');
  if (run?.failure === 'output' || typeof run?.output !== 'string' || new TextEncoder().encode(run.output).length > TEST_OUTPUT_BYTES) return error('Isolated sandbox output limit exceeded');
  if (run.failure) return error('Isolated sandbox failed');
  if (run.installExitCode !== 0) return error('Isolated sandbox dependency install failed');
  if (!Number.isInteger(run.testExitCode) || run.testExitCode < 0) return error('Isolated sandbox failed');
  const counts = parseTestCounts(run.output);
  if (!counts || counts.passed + counts.failed === 0) return error('Isolated sandbox test counts unavailable');
  return { status: run.testExitCode === 0 && counts.failed === 0 ? 'pass' : 'fail', ...counts,
    summary: `${run.fixture ? 'Isolated sandbox (local fixture)' : 'Isolated sandbox'}: ${counts.passed} passed, ${counts.failed} failed`, durationMs, provenance, sourceSha: run.sourceSha };
}
