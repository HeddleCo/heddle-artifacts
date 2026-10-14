// SPDX-License-Identifier: Apache-2.0
import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

const evidence = process.env.UI_SCREENSHOT_DIR || 'evidence/app-look';
async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}
async function shot(page: Page, name: string) {
  await page.evaluate(() => document.fonts.ready);
  await mkdir(evidence, { recursive: true });
  await page.screenshot({ path: `${evidence}/${name}.png`, animations: 'disabled' });
}

test('dashboard filters tasks, counts pending publication, and follows live landing', async ({ page, request }) => {
  await request.post('/__mock/reset', { data: { fixture: 'pushing' } });
  await page.goto('/p/demo');
  const views = page.getByRole('navigation', { name: 'Task views' });
  await expect(views.getByRole('button', { name: 'All tasks 2', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await views.getByRole('button', { name: 'Needs a decision 0', exact: true }).click();
  await expect(page.locator('.task-column')).toHaveCount(0);
  await expect(page.getByText('Nothing needs a decision right now.')).toBeVisible();
  await views.getByRole('button', { name: 'In progress 2', exact: true }).click();
  await expect(page.locator('.task-column')).toHaveCount(2);
  await views.getByRole('button', { name: 'All tasks 2', exact: true }).click();
  await expect(page.locator('.live')).toHaveText('Live');
  await request.post('/__mock/replay');
  await expect(views.getByRole('button', { name: 'Landed 1', exact: true })).toBeVisible();
  await expect(page.locator('.activity-list')).toContainText('alice');
  await expect(page.locator('.activity-list')).toContainText('Captured');
  await views.getByRole('button', { name: 'Landed 1', exact: true }).click();
  await expect(page.locator('.task-column')).toHaveCount(1);
  await expect(page.locator('.task-column')).toContainText('parser-escapes');
  await expect(page.locator('.task-column')).not.toContainText('docs-readme');

  await request.post('/__mock/reset', { data: { fixture: 'conflict', pendingPublication: true } });
  await page.reload();
  await views.getByRole('button', { name: 'Needs a decision 2', exact: true }).click();
  await expect(page.getByRole('region', { name: 'parser-escapes', exact: true })).toContainText('PUBLICATION PENDING');
  await views.getByRole('button', { name: 'Landed 0', exact: true }).click();
  await expect(page.locator('.task-column')).toHaveCount(0);
});

test('task section links preserve the decision draft and browser fragment history', async ({ page, request }) => {
  await request.post('/__mock/reset', { data: { fixture: 'conflict' } });
  await page.goto('/p/demo/t/parser-escapes');
  await expect(page.getByRole('navigation', { name: 'Tasks', exact: true }).getByRole('link', { name: /parser-escapes/ })).toHaveAttribute('aria-current', 'page');
  await page.getByRole('radio', { name: /bob/ }).check();
  await page.getByLabel('Why this candidate?').fill('Keep the API stable across captures.');
  const sections = page.getByRole('navigation', { name: 'Task sections' });
  for (const [name, id] of [['Captures', 'captures'], ['Discussion', 'discussion'], ['Context', 'context']] as const) {
    await sections.getByRole('link', { name, exact: true }).click();
    await expect(sections.getByRole('link', { name, exact: true })).toHaveAttribute('aria-current', 'location');
    await expect(page.locator(`#${id}`)).toBeInViewport();
    await expect(page.getByLabel('Why this candidate?')).toHaveValue('Keep the API stable across captures.');
  }
  await page.goBack();
  await expect(sections.getByRole('link', { name: 'Discussion', exact: true })).toHaveAttribute('aria-current', 'location');
  await sections.getByRole('link', { name: 'Candidates', exact: true }).click();
  await expect(page.getByRole('radio', { name: /bob/ })).toBeChecked();
  await page.getByRole('button', { name: 'Land candidate →' }).click();
  await expect(page.getByText('✓ Landed bob on main')).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Tasks', exact: true }).getByRole('link', { name: /parser-escapes/ })).toContainText('Landed');
});

for (const viewport of [{ width: 1280, height: 720 }, { width: 1440, height: 900 }]) {
  for (const theme of ['light', 'dark']) {
    test(`app shell and film evidence at ${viewport.width}×${viewport.height}, ${theme}`, async ({ page, request }) => {
      await page.setViewportSize(viewport);
      await page.addInitScript(t => localStorage.setItem('heddle-theme', t), theme);
      await request.post('/__mock/reset', { data: { fixture: 'conflict' } });
      await page.goto('/p/demo');
      await expect(page.getByTestId('lane-bob')).toContainText('pass · 14/14');
      const left = await page.locator('.left-rail').boundingBox(), centre = await page.locator('.page-centre').boundingBox(), right = await page.locator('.right-rail').boundingBox();
      expect(left!.width).toBe(viewport.width === 1280 ? 240 : 272);
      expect(right!.width).toBe(viewport.width === 1280 ? 280 : 320);
      expect(left!.x + left!.width).toBeLessThan(centre!.x);
      expect(centre!.x + centre!.width).toBeLessThan(right!.x);
      await noOverflow(page);
      await shot(page, `board-${viewport.width}-${theme}`);
      await page.getByRole('link', { name: 'parser-escapes', exact: true }).click();
      await expect(page.getByLabel('Diff for bob')).toContainText('const cells');
      await expect(page.locator('.task-tabs a').first()).toHaveAttribute('aria-current', 'location');
      await noOverflow(page);
      await shot(page, `candidates-${viewport.width}-${theme}`);
      await page.getByRole('navigation', { name: 'Task sections' }).getByRole('link', { name: 'Captures', exact: true }).click();
      await expect(page.locator('#captures .capture-dot')).toHaveCount(5);
      await expect(page.locator('#captures')).toBeInViewport();
      await noOverflow(page);
      await shot(page, `captures-${viewport.width}-${theme}`);
      // All decision fields and the submit action remain reachable within the scrolling rail.
      await page.getByRole('radio', { name: /bob/ }).check();
      await page.getByLabel('Why this candidate?').fill('API stability matters more than the shorter regex.');
      await page.getByLabel('Point this reason at').fill('src/table.ts:parseRow');
      await page.getByLabel('Tags', { exact: true }).fill('parseRow, whitespace');
      await expect(page.getByRole('button', { name: 'Land candidate →' })).toBeEnabled();
      await page.getByRole('button', { name: 'Land candidate →' }).click();
      await expect(page.getByText('✓ Landed bob on main')).toBeVisible();
    });
  }
}

test('mobile rails stack and keyboard controls remain reachable at 390×844', async ({ page, request }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => localStorage.setItem('heddle-theme', 'light'));
  await request.post('/__mock/reset', { data: { fixture: 'conflict' } });
  await page.goto('/p/demo');
  await expect(page.locator('.lane-card')).toHaveCount(3);
  await noOverflow(page);
  await shot(page, 'board-mobile-light');
  await page.getByRole('link', { name: 'parser-escapes', exact: true }).click();
  await expect(page.getByLabel('Diff for bob')).toContainText('const cells');
  await noOverflow(page);
  await shot(page, 'candidates-mobile-light');
  const captureLink = page.getByRole('navigation', { name: 'Task sections' }).getByRole('link', { name: 'Captures', exact: true });
  await captureLink.focus(); await page.keyboard.press('Enter');
  await expect(page.locator('#captures')).toBeInViewport();
  await expect(page.locator('.capture-dot')).toHaveCount(5);
  await noOverflow(page);
  await shot(page, 'captures-mobile-light');
  await page.getByRole('link', { name: 'Go to decision ↓' }).click();
  await expect(page.locator('#decision')).toBeInViewport();
  await page.getByRole('radio', { name: /bob/ }).focus(); await page.keyboard.press('Space');
  await page.getByLabel('Why this candidate?').fill('Keep the API stable.');
  await page.getByRole('button', { name: 'Land candidate →' }).click();
  await expect(page.getByText('✓ Landed bob on main')).toBeVisible();
  await noOverflow(page);
});
