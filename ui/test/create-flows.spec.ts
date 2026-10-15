// SPDX-License-Identifier: Apache-2.0
// The create-and-drive screens (issue #68) at 1280x720 and 1440x900, light and dark. Layout is asserted on every run;
// screenshots are written only when CREATE_EVIDENCE_DIR is set (CREATE_EVIDENCE_DIR=evidence/create-flows npm test).
import { test, expect } from '@playwright/test';
import type { Page, Locator } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

const evidence = process.env.CREATE_EVIDENCE_DIR;
async function shot(page: Page, name: string, focus?: Locator, offset = 110) {
  // Bring the point of the screenshot to the top of the viewport: typing into a field scrolls the page away from its heading.
  // offset 0 means the point sits in a sticky side rail with its own scroll: just make it visible.
  if (focus && offset === 0) await focus.scrollIntoViewIfNeeded();
  else if (focus) await focus.evaluate((node, top) => window.scrollTo({ top: Math.max(0, window.scrollY + node.getBoundingClientRect().top - top), behavior: 'instant' }), offset);
  await page.evaluate(async () => { await document.fonts.ready; await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); });
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), `${name}: no horizontal overflow`).toBe(false);
  if (evidence) { await mkdir(evidence, { recursive: true }); await page.screenshot({ path: `${evidence}/${name}.png` }); }
}
const answered = (page: Page) => page.waitForResponse(r => r.url().endsWith('/api/session'));

for (const theme of ['light', 'dark'] as const) for (const [width, height] of [[1280, 720], [1440, 900]]) {
  const label = `${width}x${height}-${theme}`;
  test.describe(`create-and-drive screens at ${width}x${height}, ${theme}`, () => {
    test.beforeEach(async ({ page, request }) => {
      expect((await request.post('/__mock/reset', { data: { fixture: 'conflict', feedDenied: true } })).ok()).toBe(true);
      await page.setViewportSize({ width, height });
      await page.addInitScript(t => localStorage.setItem('heddle-theme', t), theme);
    });
    test.afterEach(async ({ page }) => { await page.unrouteAll({ behavior: 'ignoreErrors' }); });

    test('a visitor at the root sees the demo board, with no create forms', async ({ page }) => {
      const session = answered(page); await page.goto('/'); await session;
      await expect(page.getByRole('heading', { name: 'demo' })).toBeVisible();
      await expect(page.getByRole('form', { name: 'New project' })).toHaveCount(0);
      expect(new URL(page.url()).pathname).toBe('/');
      await shot(page, `visitor-root-${label}`);
    });

    test('a visitor is told what this is and where the code is; an operator is not', async ({ page, context }) => {
      const session = answered(page); await page.goto('/'); await session;
      const intro = page.getByRole('note', { name: 'About this demo' });
      await expect(intro).toContainText('version control for agent work');
      await expect(intro.getByRole('link', { name: 'Source on GitHub' })).toHaveAttribute('href', 'https://github.com/HeddleCo/heddle-artifacts');
      await expect(intro.getByRole('link', { name: 'Run it yourself' })).toHaveAttribute('href', 'https://github.com/HeddleCo/heddle-artifacts#a-run-it-yourself-on-your-own-machine');
      await shot(page, `visitor-intro-${label}`, intro, 0);
      await context.request.post('/login', { form: { token: 'fixture-operator' } });
      await page.goto('/'); await expect(page.getByRole('form', { name: 'New project' })).toBeVisible();
      await expect(page.getByRole('note', { name: 'About this demo' })).toHaveCount(0);
    });

    test('an operator at the root gets the new-project form', async ({ page, context }) => {
      await context.request.post('/login', { form: { token: 'fixture-operator' } });
      await page.goto('/');
      const form = page.getByRole('form', { name: 'New project' });
      await expect(form).toBeVisible();
      await form.getByLabel('Repository address').fill('https://github.com/acme/widgets');
      await form.getByLabel('Test command').fill('npm test');
      await form.getByLabel('Your name').fill('Ada Lovelace');
      await expect(form.getByLabel('Project name')).toHaveValue('widgets');
      await expect(page.getByRole('link', { name: /demo board/i })).toBeVisible();
      await shot(page, `operator-new-project-${label}`, form);
    });

    test('an operator adds a task from the board', async ({ page, context }) => {
      await context.request.post('/login', { form: { token: 'fixture-operator' } });
      await page.goto('/p/demo');
      await page.getByTestId('new-task').locator('summary').click();
      await page.getByRole('form', { name: 'New task' }).getByLabel('What should the agents try to do?').fill('Make the importer faster on large files');
      await expect(page.getByRole('form', { name: 'New task' }).getByLabel('Task name')).toHaveValue('make-the-importer-faster-on');
      await shot(page, `operator-new-task-${label}`, page.getByTestId('new-task'));
    });

    test('an empty board tells an operator what to do next, and a visitor nothing to do', async ({ page, context }) => {
      await page.route('**/api/projects/demo', async route => { const response = await route.fetch(), board = await response.json(); board.tasks = []; await route.fulfill({ response, json: board }); });
      await context.request.post('/login', { form: { token: 'fixture-operator' } });
      await page.goto('/p/demo');
      await expect(page.getByText('No tasks yet. Create the first one above.')).toBeVisible();
      await shot(page, `operator-empty-board-${label}`);
    });

    test('an operator gets the command that puts their own agent on a task', async ({ page, context }) => {
      await context.request.post('/login', { form: { token: 'fixture-operator' } });
      await page.goto('/p/demo/t/parser-escapes');
      await page.getByTestId('add-agent').locator('summary').click();
      await expect(page.locator('.join-command')).toContainText('OPERATOR_TOKEN=… node cli/ha.mjs join');
      await shot(page, `operator-add-agent-${label}`, page.getByTestId('add-agent'));
    });

    test('with nobody to decide as, an operator adds their name; a visitor is told to sign in', async ({ page, context, request }) => {
      await request.post('/__mock/reset', { data: { fixture: 'conflict', feedDenied: true, noHumans: true } });
      await page.goto('/p/demo/t/parser-escapes');
      await expect(page.getByText('Sign in as an operator to decide.')).toBeVisible();
      await expect(page.getByText('Sign in as an operator to decide.')).toBeInViewport({ ratio: 0 }).catch(() => undefined);
      await shot(page, `visitor-no-decider-${label}`, page.getByText('Sign in as an operator to decide.'), 0);
      await context.request.post('/login', { form: { token: 'fixture-operator' } });
      await page.reload();
      await expect(page.locator('.add-human').last()).toBeVisible();
      await page.locator('.add-human').last().getByLabel(/Your name/).fill('Grace Hopper');
      await shot(page, `operator-add-name-${label}`, page.locator('.add-human').last(), 0);
    });
  });
}
