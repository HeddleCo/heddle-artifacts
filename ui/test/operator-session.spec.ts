// SPDX-License-Identifier: Apache-2.0
// The header shows whether you are signed in; a wrong token is explained on the sign-in page; an operator can get a read token.
import { test, expect } from '@playwright/test';

const reset = (request: any, fixture = 'decided') => request.post('/__mock/reset', { data: { fixture, feedDenied: true } });
const why = `/p/demo/why/${'f'.repeat(40)}`;
test.beforeEach(async ({ request }) => { expect((await reset(request)).ok()).toBe(true); });

test('the header follows the session: sign in, a wrong token explained, signed in, signed out', async ({ page }) => {
  await page.goto('/p/demo');
  const header = page.locator('header');
  await expect(header.getByRole('link', { name: 'Sign in' })).toBeVisible();
  await page.goto('/login');
  await page.getByLabel('Operator token').fill('not-the-token');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/login\?error=token$/);
  await expect(page.getByRole('alert')).toContainText('That operator token was not accepted');
  await expect(page.locator('body')).not.toContainText('"error"');
  await page.getByLabel('Operator token').fill('fixture-operator');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/p\/demo$/);
  await expect(header.getByText('Signed in as operator')).toBeVisible();
  await expect(header.getByRole('link', { name: 'Sign in' })).toHaveCount(0);
  await header.getByRole('button', { name: 'Sign out' }).click();
  await expect(header.getByRole('link', { name: 'Sign in' })).toBeVisible();
});

test('an operator issues a read token on the Why page; a visitor is told where one comes from', async ({ page, context }) => {
  await page.goto(why);
  await expect(page.locator('.git-instructions')).toContainText('refused (403)');
  await expect(page.getByRole('button', { name: 'Issue a read token' })).toHaveCount(0);
  await expect(page.locator('.git-instructions')).toContainText('ha join');
  await context.request.post('/login', { form: { token: 'fixture-operator' } });
  await page.goto(why);
  await page.getByRole('button', { name: 'Issue a read token' }).click();
  await expect(page.getByLabel(/Read token/)).toHaveValue('fixture-read-token');
});

test('a task page says when AI review is off and how to turn it on', async ({ page, request }) => {
  await request.post('/__mock/reset', { data: { fixture: 'conflict', feedDenied: true, noReview: true } });
  await page.goto('/p/demo/t/parser-escapes');
  const panel = page.getByRole('region', { name: 'AI review' });
  await expect(panel.getByRole('heading', { name: 'AI review is off' })).toBeVisible();
  await expect(panel).toContainText('node cli/up.mjs local --review');
  await expect(panel).toContainText('npx wrangler login');
});
