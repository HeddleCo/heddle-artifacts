// SPDX-License-Identifier: Apache-2.0
import { test, expect } from '@playwright/test';

test('captures retains lane history, shares a time axis, and navigates across agents in light theme', async ({ page, request }) => {
  await request.post('/__mock/reset', { data: { fixture: 'conflict' } });
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.addInitScript(() => localStorage.setItem('heddle-theme', 'light'));
  await page.goto('/p/demo/t/parser-escapes#captures');
  const panel = page.getByRole('region', { name: 'Captures', exact: true });
  await expect(panel.locator('.capture-dot')).toHaveCount(5);
  await expect(panel.locator('.capture-track')).toHaveCount(2);
  await expect(panel.locator('[data-agent="alice"] .capture-dot')).toHaveCount(3);
  // alice's briefing carried no earlier decisions (zero annotations), so like her lane card she gets no tag.
  await expect(panel.locator('[data-agent="alice"] .capture-label')).not.toContainText('◆ briefed');
  await expect(panel.locator('[data-agent="alice"] .capture-label .tag')).toHaveCount(0);
  await expect(panel.locator('[data-agent="bob"]')).toContainText('○ control');
  await expect(panel).toContainText('Lighter spans run from when each lane opened');
  await expect(panel.locator('.capture-detail')).toContainText('Add the row parser');
  await expect(panel.locator('.capture-detail')).toContainText('Function added: parseRow in src/table.ts');
  await expect(panel.locator('.capture-detail')).toContainText('1111111111');
  await expect(panel.locator('.capture-detail')).toContainText('Tests: fail');
  await expect(panel.getByRole('button', { name: 'Previous', exact: true })).toBeDisabled();
  await panel.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(panel.locator('.capture-detail')).toContainText('Bob · CAPTURE 2 OF 5');
  await expect(panel.locator('.capture-detail')).toContainText('Function modified: parseRow in src/table.ts');
  await expect(panel.locator('.capture-detail')).toContainText('Tests: pass');
  await panel.getByRole('button', { name: 'Next', exact: true }).press('ArrowRight');
  await expect(panel.locator('.capture-detail')).toContainText('Handle escaped pipes');
  await expect(panel.locator('.capture-detail')).toContainText('Semantic summary unavailable');
  await page.keyboard.press('ArrowRight');
  await expect(panel.locator('.capture-detail')).toContainText('Bob · CAPTURE 4 OF 5');
  await page.keyboard.press('ArrowRight');
  await expect(panel.locator('.capture-detail')).toContainText('Alice · CAPTURE 5 OF 5');
  await expect(panel.getByRole('button', { name: 'Next', exact: true })).toBeDisabled();
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await expect(panel.locator('.capture-detail')).toContainText('Handle escaped pipes');
  const dots = await panel.locator('.capture-dot').evaluateAll(nodes => nodes.map(n => ({ agent: n.closest('.capture-track')!.getAttribute('data-agent'), x: n.getBoundingClientRect().x })));
  expect(dots[0].x).toBeLessThan(dots[3].x); expect(dots[3].x).toBeLessThan(dots[2].x);
  const spans = await panel.locator('.capture-span').evaluateAll(nodes => nodes.map(n => n.getBoundingClientRect().width));
  expect(spans).toHaveLength(2); expect(spans.every(width => width > 0)).toBe(true);
  // Both lanes have openedAt: each working span starts before its first capture and runs to its last one,
  // and the two overlap because alice and bob worked at the same time.
  const box = (selector: string) => panel.locator(selector).evaluate(n => { const r = n.getBoundingClientRect(); return { left: r.left, right: r.right }; });
  await expect(panel.locator('.capture-working')).toHaveCount(2);
  const working = { alice: await box('[data-agent="alice"] .capture-working'), bob: await box('[data-agent="bob"] .capture-working') };
  for (const agent of ['alice', 'bob'] as const) {
    const span = await box(`[data-agent="${agent}"] .capture-span`), first = await panel.locator(`[data-agent="${agent}"] .capture-dot`).first().boundingBox();
    expect(working[agent].left).toBeLessThan(span.left - 20); expect(working[agent].left).toBeLessThan(first!.x);
    expect(Math.abs(working[agent].right - span.right)).toBeLessThan(1);
  }
  expect(working.alice.left).toBeLessThan(working.bob.left); expect(working.bob.left).toBeLessThan(working.alice.right);
  await expect(panel).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  await page.screenshot({ path: 'evidence/captures-light.png' });
});

test('captures tags a lane briefed with earlier decisions and keeps the capture-only rendering without openedAt', async ({ page, request }) => {
  await request.post('/__mock/reset', { data: { fixture: 'conflict' } });
  await page.goto('/p/demo/t/docs-readme#captures');
  const panel = page.getByRole('region', { name: 'Captures', exact: true });
  await expect(panel.locator('[data-agent="carol"] .capture-dot')).toHaveCount(1);
  await expect(panel.locator('[data-agent="carol"] .capture-label')).toContainText('◆ briefed');
  await expect(panel.locator('.capture-working'), 'a lane opened before openedAt was recorded draws no working span').toHaveCount(0);
  await expect(panel.locator('.capture-span')).toHaveCount(1);
  await expect(panel).toContainText('Spans show when agents worked in parallel.');
});

test('captures refetches for live pushes and candidates without navigation', async ({ page, request }) => {
  await request.post('/__mock/reset', { data: { fixture: 'pushing' } });
  await page.goto('/p/demo/t/parser-escapes');
  await expect(page.locator('.live')).toHaveText('Live');
  const panel = page.locator('#captures');
  await expect(panel).toContainText('No captures yet');
  let reads = 0; page.on('request', r => { if (r.url().endsWith('/captures')) reads++; });
  const before = page.url(); await request.post('/__mock/replay');
  await expect(panel.locator('.capture-dot')).toHaveCount(2);
  expect(reads).toBeGreaterThanOrEqual(4); expect(page.url()).toBe(before);
});

test('pending summaries are refetched and selection survives the update', async ({ page, request }) => {
  await request.post('/__mock/reset', { data: { fixture: 'conflict' } });
  let reads = 0;
  await page.route('**/tasks/parser-escapes/captures', async route => {
    const response = await route.fetch(), data = await response.json(); reads++;
    if (reads === 1) { data.pending = 1; data.lanes[0].captures[0].semantic = { status: 'pending' }; }
    await route.fulfill({ json: data });
  });
  await page.goto('/p/demo/t/parser-escapes');
  await expect(page.locator('#captures .capture-detail')).toContainText('Semantic summary pending');
  await page.locator('#captures').getByRole('button', { name: 'Next', exact: true }).click();
  await expect.poll(() => reads).toBeGreaterThan(1);
  await expect(page.locator('#captures .capture-detail')).toContainText('Bob · CAPTURE 2 OF 5');
  await page.unrouteAll({ behavior: 'ignoreErrors' });
});
