// SPDX-License-Identifier: Apache-2.0
export const TEST_BUDGET_MS = 180000;
// A project's operator-set test recipe may give its sandbox runs a longer wall-clock budget.
export const MIN_TEST_BUDGET_MS = 30000, MAX_TEST_BUDGET_MS = 600000;
export function testBudgetMs(run) {
  const budget = run?.budgetMs;
  return Number.isInteger(budget) && budget >= MIN_TEST_BUDGET_MS && budget <= MAX_TEST_BUDGET_MS ? budget : TEST_BUDGET_MS;
}
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

export const FAILURE_NAMES = 20, FAILURE_NAME_CHARS = 200, EXCERPT_CHARS = 4000;
/**
 * Name the failing tests and keep the part of the runner output that explains them, so a
 * reader (or the agent that must fix them) sees what broke. Parsed from runner stdout only.
 */
export function failureDetails(output) {
  const text = String(output ?? '').replace(/\x1b\[[0-9;]*m/g, '').replace(/\r/g, '');
  const vitest = [...text.matchAll(/^\s*FAIL\s+(.+?)\s*$/gm)].map(m => m[1]);
  const tap = [...text.matchAll(/^\s*not ok \d+ - (.+?)\s*$/gm)].map(m => m[1].replace(/\s+#.*$/, ''));
  const spec = [...text.matchAll(/^\s*✖ (.+?)(?: \([\d.]+m?s\))?\s*$/gm)].map(m => m[1]).filter(name => name !== 'failing tests:');
  const names = [...new Set(vitest.length ? vitest : tap.length ? tap : spec)].slice(0, FAILURE_NAMES).map(name => name.slice(0, FAILURE_NAME_CHARS));
  const marks = [/^.*Failed Tests \d+.*$/m, /^\s*FAIL\s/m, /^.*✖ failing tests:.*$/m, /^\s*not ok \d+/m].map(re => re.exec(text)?.index).filter(i => i !== undefined);
  const start = marks.length ? Math.min(...marks) : Math.max(0, text.length - EXCERPT_CHARS);
  const excerpt = text.slice(start, start + EXCERPT_CHARS).trim();
  return { failures: names, excerpt };
}

export function isolatedTestResult(run) {
  const provenance = run?.local ? 'local run (not isolated)' : run?.fixture ? 'isolated sandbox (local fixture)' : 'isolated sandbox';
  const budgetMs = testBudgetMs(run);
  const durationMs = Number.isFinite(run?.durationMs) ? Math.min(budgetMs, Math.max(0, Math.round(run.durationMs))) : 0;
  const error = summary => ({ status: 'error', passed: 0, failed: 0, summary, durationMs, provenance, sourceSha: run?.sourceSha });
  if (run?.failure === 'timeout' || run?.durationMs >= budgetMs || [run?.installExitCode, run?.testExitCode].some(c => c === 124 || c === 137)) return error(`Isolated sandbox exceeded ${budgetMs / 1000} seconds`);
  if (run?.failure === 'output' || typeof run?.output !== 'string' || new TextEncoder().encode(run.output).length > TEST_OUTPUT_BYTES) return error('Isolated sandbox output limit exceeded');
  if (run.failure) return error('Isolated sandbox failed');
  if (run.installExitCode !== 0) return error('Isolated sandbox dependency install failed');
  if (!Number.isInteger(run.testExitCode) || run.testExitCode < 0) return error('Isolated sandbox failed');
  const counts = parseTestCounts(run.output);
  if (!counts || counts.passed + counts.failed === 0) return error('Isolated sandbox test counts unavailable');
  const status = run.testExitCode === 0 && counts.failed === 0 ? 'pass' : 'fail';
  return { status, ...counts,
    summary: `${run.local ? 'Local run (not isolated)' : run.fixture ? 'Isolated sandbox (local fixture)' : 'Isolated sandbox'}: ${counts.passed} passed, ${counts.failed} failed`, durationMs, provenance, sourceSha: run.sourceSha,
    ...(status === 'fail' ? failureDetails(run.output) : {}) };
}
