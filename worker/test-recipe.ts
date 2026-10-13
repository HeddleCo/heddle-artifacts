// SPDX-License-Identifier: Apache-2.0
import { HttpError } from './auth';
import { MAX_TEST_BUDGET_MS, MIN_TEST_BUDGET_MS, TEST_BUDGET_MS } from '../engine/lib/isolated-tests.mjs';

/**
 * How the isolated sandbox tests a project's candidates. The operator sets it when creating the
 * project; candidate code cannot change it. Setup steps run in order and stop at the first non-zero
 * exit; only the test step's output is kept and parsed for counts. Every step is argv, never a shell.
 */
export interface TestRecipe { setup: string[][]; test: string[]; budgetMs: number }

export const DEFAULT_TEST_RECIPE: TestRecipe = {
  setup: [['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund']], test: ['npm', 'test'], budgetMs: TEST_BUDGET_MS,
};

// Package-manager entry points only: the sandbox image ships Node, npm and npx, and npx can fetch a pinned pnpm.
const PROGRAMS = new Set(['npm', 'npx', 'node']);
const MAX_SETUP = 6, MAX_ARGS = 48, MAX_ARG = 256;

function argv(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_ARGS) throw new HttpError(400, 'invalid_test_recipe');
  for (const arg of value) if (typeof arg !== 'string' || !arg || arg.length > MAX_ARG || /[\0-\x1f\x7f]/.test(arg)) throw new HttpError(400, 'invalid_test_recipe');
  if (!PROGRAMS.has(value[0])) throw new HttpError(400, 'invalid_test_recipe');
  return [...value];
}

/** Validate an operator-supplied recipe: `{ setup?: argv[], test: argv, budgetSeconds?: 30..600 }`. */
export function parseTestRecipe(value: unknown): TestRecipe {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'invalid_test_recipe');
  const { setup = [], test, budgetSeconds = TEST_BUDGET_MS / 1000, ...rest } = value as Record<string, unknown>;
  if (Object.keys(rest).length || !Array.isArray(setup) || setup.length > MAX_SETUP) throw new HttpError(400, 'invalid_test_recipe');
  const budgetMs = Number(budgetSeconds) * 1000;
  if (!Number.isInteger(budgetSeconds) || budgetMs < MIN_TEST_BUDGET_MS || budgetMs > MAX_TEST_BUDGET_MS) throw new HttpError(400, 'invalid_test_recipe');
  return { setup: setup.map(argv), test: argv(test), budgetMs };
}
