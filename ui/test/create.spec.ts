// SPDX-License-Identifier: Apache-2.0
import { test, expect } from '@playwright/test';

const reset = (request: any, extra: object = {}) => request.post('/__mock/reset', { data: { fixture: 'conflict', feedDenied: true, ...extra } });
const sent = async (request: any) => (await (await request.get('/__mock/requests')).json()) as Array<{ path: string; body: any }>;
const signIn = (context: any) => context.request.post('/login', { form: { token: 'fixture-operator' } });
const creates = (calls: Array<{ path: string }>) => calls.filter(c => c.path === '/api/projects' || /\/(tasks|humans)$/.test(c.path));

test.beforeEach(async ({ request }) => { expect((await reset(request)).ok()).toBe(true); });

test('a visitor who is not an operator sees no create form anywhere', async ({ page, request }) => {
  expect(await (await request.get('/api/session')).json()).toEqual({ operator: false, demo: 'demo' });
  await page.goto('/');
  await expect(page.getByRole('form', { name: 'New project' })).toHaveCount(0);
  await page.goto('/p/demo');
  await expect(page.getByRole('heading', { name: 'demo' })).toBeVisible();
  await expect(page.getByTestId('new-task')).toHaveCount(0);
  await page.goto('/p/demo/t/parser-escapes');
  await expect(page.getByTestId('add-agent')).toHaveCount(0);
  expect(creates(await sent(request))).toEqual([]);
});

test('the create routes refuse a visitor even if called directly', async ({ request }) => {
  for (const [path, data] of [['/api/projects', { id: 'x', seed: { template: 'demo' } }], ['/api/projects/demo/tasks', { slug: 'x', intent: 'y' }], ['/api/projects/demo/humans', { id: 'x', displayName: 'X' }]] as const)
    expect((await request.post(path, { data })).status(), path).toBe(403);
});

test('an operator creates a project from a repository address: id suggested, project and human created, then the board opens', async ({ page, context, request }) => {
  await signIn(context);
  await page.goto('/');
  const form = page.getByRole('form', { name: 'New project' });
  await form.getByLabel('Repository address').fill('https://github.com/acme/Widgets.git');
  await expect(form.getByLabel('Project name')).toHaveValue('widgets');
  await form.getByLabel('Test command').fill('npm run check');
  await form.getByLabel('Your name').fill('Ada Lovelace');
  await form.getByRole('button', { name: 'Create project' }).click();
  await expect(page).toHaveURL(/\/p\/widgets$/);
  const calls = creates(await sent(request));
  expect(calls[0]).toEqual({ path: '/api/projects', body: { id: 'widgets', seed: { importUrl: 'https://github.com/acme/Widgets.git', snapshot: true }, tests: { setup: [], test: ['npm', 'run', 'check'] } } });
  expect(calls[1]).toEqual({ path: '/api/projects/widgets/humans', body: { id: 'ada-lovelace', displayName: 'Ada Lovelace' } });
});

test('bad input is explained and nothing is sent', async ({ page, context, request }) => {
  await signIn(context);
  await page.goto('/');
  const form = page.getByRole('form', { name: 'New project' });
  await form.getByLabel('Repository address').fill('http://github.com/acme/widgets');
  await form.getByLabel('Your name').fill('Ada');
  await form.getByRole('button', { name: 'Create project' }).click();
  await expect(form.getByRole('alert')).toContainText('https');
  await form.getByLabel('Repository address').fill('https://github.com/acme/widgets');
  await form.getByLabel('Test command').fill('sh -c "echo hi"');
  await form.getByRole('button', { name: 'Create project' }).click();
  await expect(form.getByRole('alert')).toContainText('npm, npx or node');
  expect(creates(await sent(request))).toEqual([]);
});

test('an operator adds a task from the board and sees it listed', async ({ page, context, request }) => {
  await signIn(context);
  await page.goto('/p/demo');
  await page.getByTestId('new-task').locator('summary').click();
  const form = page.getByRole('form', { name: 'New task' });
  await form.getByLabel('What should the agents try to do?').fill('Make the importer faster on large files');
  await expect(form.getByLabel('Task name')).toHaveValue('make-the-importer-faster-on');
  await form.getByRole('button', { name: 'Create task' }).click();
  await expect(page.getByRole('link', { name: 'make-the-importer-faster-on' })).toBeVisible();
  expect(creates(await sent(request))).toEqual([{ path: '/api/projects/demo/tasks', body: { slug: 'make-the-importer-faster-on', intent: 'Make the importer faster on large files' } }]);
  await form.getByLabel('What should the agents try to do?').fill('again');
  await form.getByLabel('Task name').fill('make-the-importer-faster-on');
  await form.getByRole('button', { name: 'Create task' }).click();
  await expect(form.getByRole('alert')).toContainText('already taken');
});

test('an operator gets the exact command to put their own agent on a task, with no token in it', async ({ page, context }) => {
  await signIn(context);
  await page.goto('/p/demo/t/parser-escapes');
  await page.getByTestId('add-agent').locator('summary').click();
  const command = page.locator('.join-command');
  await expect(command).toContainText(`OPERATOR_TOKEN=… node cli/ha.mjs join ${new URL(page.url()).origin}/p/demo --task parser-escapes --as agent-1 --dir ./agent-1`);
  expect(await command.textContent()).not.toMatch(/\bexport\b/);
  expect(await command.textContent()).not.toContain('fixture-operator');
  await page.getByTestId('add-agent').getByLabel('Agent name').fill('my agent; rm -rf ~');
  await expect(command).toHaveCount(0);
  await expect(page.getByTestId('add-agent')).toContainText('lowercase letters');
});

test('with no human identity, an operator adds their name instead of being sent to the API; a visitor is told to sign in', async ({ page, context, request }) => {
  await reset(request, { noHumans: true });
  await page.goto('/p/demo/t/parser-escapes');
  await expect(page.getByText('Sign in as an operator to decide.')).toBeVisible();
  await expect(page.getByText(/through the project API/)).toHaveCount(0);
  await signIn(context);
  await page.reload();
  await page.locator('.add-human').last().getByLabel(/Your name/).fill('Grace Hopper');
  await page.locator('.add-human').last().getByRole('button', { name: 'Add me' }).click();
  await expect(page.getByLabel('Decide as').locator('option', { hasText: 'Grace Hopper' })).toHaveCount(1);
  expect(creates(await sent(request))).toEqual([{ path: '/api/projects/demo/humans', body: { id: 'grace-hopper', displayName: 'Grace Hopper' } }]);
});

test('the root URL is the public demo board for a visitor, with the address left as /', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'demo' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'parser-escapes' }).first()).toBeVisible();
  expect(new URL(page.url()).pathname).toBe('/');
  await expect(page.getByRole('button', { name: 'Open board →' })).toHaveCount(0);
});

test('the root URL stays the operator home: create form and a link to the demo, not the board', async ({ page, context }) => {
  await signIn(context);
  await page.goto('/');
  await expect(page.getByRole('form', { name: 'New project' })).toBeVisible();
  await expect(page.getByRole('link', { name: /demo board/i })).toHaveAttribute('href', '/p/demo');
  await expect(page.locator('.board')).toHaveCount(0);
});

test('with no demo project, the root is the project picker, and an unknown path is still not found', async ({ page }) => {
  await page.route('**/api/session', route => route.fulfill({ json: { operator: false } }));
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Open board →' })).toBeVisible();
  await page.goto('/nowhere');
  await expect(page.getByRole('heading', { name: 'Page not found.' })).toBeVisible();
});

test('with a demo configured, an unknown path is still "not found", not the demo board', async ({ page }) => {
  await page.goto('/nowhere');
  await expect(page.getByRole('heading', { name: 'Page not found.' })).toBeVisible();
  await expect(page.locator('.board')).toHaveCount(0);
});
