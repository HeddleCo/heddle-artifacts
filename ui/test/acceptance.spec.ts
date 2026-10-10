// SPDX-License-Identifier: Apache-2.0
import { test, expect } from '@playwright/test';
import type { Page, APIRequestContext } from '@playwright/test';
const shots = process.env.UI_SCREENSHOT_DIR || 'evidence';
const why = `/p/demo/why/${'f'.repeat(40)}`;
async function reset(request: APIRequestContext, fixture = 'conflict', decisionStatus = 200) {
  const response = await request.post('/__mock/reset', { data: { fixture, decisionStatus } }); expect(response.status()).toBe(200);
}
async function choose(page: Page) {
  await page.goto('/p/demo/t/parser-escapes');
  await expect(page.getByLabel('Diff for bob')).toContainText('const cells');
  await page.getByRole('radio', { name: /bob/ }).check();
  await page.getByLabel('Why this candidate?').fill('API stability matters more than the shorter regex.');
}

test('C-T1 fixture screens: pushing board, conflict compare, decided why', async ({ page, request }) => {
  await reset(request, 'pushing'); await page.goto('/p/demo');
  await expect(page.getByRole('heading', { name: 'Work in parallel. Decide together.' })).toBeVisible();
  await expect(page.locator('.lane-card')).toHaveCount(3);
  await expect(page.getByTestId('lane-alice')).toContainText('Waiting for a push');
  await reset(request, 'conflict'); await page.goto('/p/demo/t/parser-escapes');
  await expect(page.getByRole('region', { name: 'Conflict regions' })).toContainText('src/table.ts:parseRow');
  await expect(page.locator('.candidate')).toHaveCount(2);
  await expect(page.getByLabel('alice candidate')).toContainText('fail · 12/14');
  await expect(page.getByLabel('bob candidate')).toContainText('pass · 14/14');
  await expect(page.getByLabel('bob candidate')).toContainText('ed25519:bbbbbbbb…bbbbbbbb');
  await expect(page.getByLabel('bob candidate')).toContainText('anthropic / sonnet');
  await expect(page.getByRole('heading', { name: 'Recommendation: bob' })).toBeVisible();
  await reset(request, 'decided'); await page.goto(why);
  await expect(page.locator('.narrative')).toContainText('Chosen:    bob');
  await expect(page.locator('.narrative')).toContainText('Rejected:  alice');
  await expect(page.locator('.verification')).toContainText('Unavailable from the current API');
  await expect(page.locator('.git-instructions')).toContainText("git log --notes='heddle*' -3");
  await expect(page.locator('.git-instructions')).toContainText("clone 'https://example.artifacts.cloudflare.net/git/heddle-demo/demo.git'");
});

test('C-T2 WebSocket replay updates board without reload', async ({ page, request }) => {
  await reset(request, 'pushing'); await page.goto('/p/demo');
  await expect(page.locator('.live')).toHaveText('Live');
  const navigation: string[] = [];
  page.on('framenavigated', frame => { if (frame === page.mainFrame()) navigation.push(frame.url()); });
  const apiReads: string[] = []; page.on('request', r => { if (r.url().includes('/api/') && r.method() === 'GET') apiReads.push(r.url()); });
  const response = await request.post('/__mock/replay'); expect(response.status()).toBe(200);
  await expect(page.getByTestId('lane-alice')).toHaveAttribute('data-push', 'received');
  await expect(page.getByTestId('lane-alice')).toContainText('fail · 12/14');
  await expect(page.getByTestId('lane-bob')).toContainText('pass · 14/14');
  await expect(page.getByTestId('lane-carol')).toContainText('Clean candidate');
  await expect(page.getByRole('link', { name: /Why ffffffffff landed/ })).toBeVisible();
  expect(navigation).toEqual([]); expect(apiReads).toEqual([]);
});

for (const status of [200, 403, 409]) test(`C-T3 decision exact body and ${status} response`, async ({ page, request }) => {
  await reset(request, 'conflict', status); await choose(page);
  const posted = page.waitForRequest(r => r.url().endsWith('/decision') && r.method() === 'POST');
  await page.getByRole('button', { name: 'Land candidate →' }).click();
  const r = await posted;
  expect(r.postDataJSON()).toEqual({ pick: 'bob', rationale: 'API stability matters more than the shorter regex.', decider: 'luke', expectHeads: ['state-alice-1', 'state-bob-1'] });
  if (status === 200) await expect(page.getByText('✓ Landed bob on main')).toBeVisible();
  if (status === 403) { await expect(page.getByRole('alert')).toContainText('Access denied'); await expect(page.getByRole('button', { name: 'Land candidate →' })).toBeEnabled(); }
  if (status === 409) {
    await expect(page.getByRole('alert')).toContainText('Candidates changed, review again');
    await expect(page.getByRole('button', { name: 'Land candidate →' })).toBeDisabled();
    await page.getByRole('button', { name: 'Review current candidates' }).click();
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(page.getByRole('radio', { name: /bob/ })).not.toBeChecked();
  }
});

test('C-T3 required rationale and signed human discussion', async ({ page, request }) => {
  await reset(request); await page.goto('/p/demo/t/parser-escapes');
  await page.getByRole('radio', { name: /bob/ }).check();
  await expect(page.getByRole('button', { name: 'Land candidate →' })).toBeDisabled();
  await page.getByLabel('Why this candidate?').fill('   ');
  await expect(page.getByRole('button', { name: 'Land candidate →' })).toBeDisabled();
  await page.getByRole('button', { name: 'Reply to reviewer' }).click();
  await page.getByLabel('Your reply').fill('Keep the API stable.');
  await page.getByRole('button', { name: 'Post signed reply' }).click();
  await expect(page.locator('.discussion')).toContainText('Keep the API stable.');
  const posted = await (await request.get('/__mock/requests')).json();
  expect(posted[0].body).toEqual({ body: 'Keep the API stable.', as: 'luke', replyTo: 'turn-review' });
});

test('C-T4 wrangler smoke: board, compare, keyboard decision, why, login, screenshots', async ({ page, request }) => {
  await reset(request); await page.goto('/p/demo');
  await expect(page.getByRole('link', { name: 'parser-escapes', exact: true })).toBeVisible();
  expect((await page.getByTestId('lane-bob').boundingBox())!.y + (await page.getByTestId('lane-bob').boundingBox())!.height).toBeLessThan(720);
  await page.screenshot({ path: `${shots}/board-dark.png` });
  await page.getByRole('button', { name: 'Switch to light theme' }).click();
  await page.screenshot({ path: `${shots}/board-light.png` });
  await page.getByRole('link', { name: 'parser-escapes', exact: true }).click();
  await expect(page.getByLabel('Diff for bob')).toContainText('const cells');
  await page.screenshot({ path: `${shots}/compare-light.png`, fullPage: true });
  await page.getByRole('button', { name: 'Switch to dark theme' }).click();
  await page.screenshot({ path: `${shots}/compare-dark.png`, fullPage: true });
  await page.getByRole('radio', { name: /bob/ }).focus(); await page.keyboard.press('Space');
  await page.getByLabel('Why this candidate?').fill('Preserve the public API.');
  await page.getByRole('button', { name: 'Land candidate →' }).focus(); await page.keyboard.press('Enter');
  await page.getByRole('link', { name: /See why/ }).click();
  await expect(page.locator('.narrative')).toContainText('Chosen:    bob');
  await page.screenshot({ path: `${shots}/why-dark.png`, fullPage: true });
  await page.getByRole('button', { name: 'Switch to light theme' }).click();
  await page.screenshot({ path: `${shots}/why-light.png`, fullPage: true });
  await page.goto('/login');
  await page.getByLabel('Operator token').fill('fixture-operator');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/p\/demo$/);
  const cookies = await page.context().cookies();
  expect(cookies.find(c => c.name === 'fixture_session')?.httpOnly).toBe(true);
  await expect(page.locator('body')).not.toContainText('fixture-operator');
  const horizontalOverflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  expect(horizontalOverflow).toBe(false);
});
