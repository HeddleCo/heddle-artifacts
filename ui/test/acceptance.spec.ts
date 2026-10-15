// SPDX-License-Identifier: Apache-2.0
import { test, expect } from '@playwright/test';
import type { Page, APIRequestContext } from '@playwright/test';
const shots = process.env.UI_SCREENSHOT_DIR || 'evidence';
// Pages refetch while a test's last assertion passes; drop in-flight route handlers instead of failing on them.
test.afterEach(async ({ page }) => { await page.unrouteAll({ behavior: 'ignoreErrors' }); });
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
  await expect(page.getByRole('heading', { name: 'demo', level: 1, exact: true })).toBeVisible();
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
  await reset(request, 'decided'); await page.goto('/p/demo/t/parser-escapes');
  await expect(page.getByRole('heading', { name: 'Recorded decision' })).toBeVisible();
  await expect(page.getByLabel('Point this reason at')).toHaveCount(0);
  await expect(page.getByLabel('Tags', { exact: true })).toHaveCount(0);
  await expect(page.locator('.decision .recorded-anchor, .decision .recorded-tags')).toHaveCount(0);
  await expect(page.locator('.decision')).not.toContainText('src/table.ts:parseRow');
  await page.goto(why);
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

test('decision sends optional symbol anchor and comma-separated tags, then displays both at 1920×1080', async ({ page, request }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await reset(request); await choose(page);
  await expect(page.getByLabel('Point this reason at')).toHaveAttribute('placeholder', 'path/to/file.ts:symbol');
  await expect(page.getByLabel('Tags', { exact: true })).toHaveAttribute('placeholder', 'tag-one, tag-two');
  await page.getByLabel('Point this reason at').fill('src/table.ts:parseRow');
  await page.getByLabel('Tags', { exact: true }).fill('parseRow, whitespace');
  await page.screenshot({ path: `${shots}/decision-anchor-tags-1920.png`, fullPage: true });
  const posted = page.waitForRequest(r => r.url().endsWith('/decision') && r.method() === 'POST');
  await page.getByRole('button', { name: 'Land candidate →' }).click();
  expect((await posted).postDataJSON()).toEqual({ pick: 'bob', rationale: 'API stability matters more than the shorter regex.', decider: 'luke', expectHeads: ['state-alice-1', 'state-bob-1'], anchor: 'src/table.ts:parseRow', tags: ['parseRow', 'whitespace'] });
  await expect(page.locator('.notice.landed .anchor-chip')).toHaveAttribute('title', 'src/table.ts:parseRow');
  await expect(page.locator('.notice.landed .tag')).toHaveText(['parseRow', 'whitespace']);
  await expect(page.getByLabel('Point this reason at')).toHaveCount(0);
  await expect(page.getByLabel('Tags', { exact: true })).toHaveCount(0);
  await expect(page.locator('.decision .recorded-anchor .anchor-chip')).toHaveAttribute('title', 'src/table.ts:parseRow');
  await expect(page.locator('.decision .recorded-tags .tag')).toHaveText(['parseRow', 'whitespace']);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  await page.screenshot({ path: `${shots}/decision-anchor-tags-landed-1920.png`, fullPage: true });
});

test('Context supplied shows annotation symbol scope and tags', async ({ page, request }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await reset(request);
  await page.route('**/api/projects/demo', async route => {
    const response = await route.fetch(), board = await response.json();
    board.tasks[0].lanes[0].briefing = { hash: 'b'.repeat(64), omitted: 0, annotations: [{ target: 'src/table.ts', scope: 'symbol:parseRow', annotationId: 'ann', revisionId: 'rev', kind: 'rationale', content: 'Preserve whitespace in parseRow.', tags: ['parseRow', 'whitespace'], attribution: 'Luke <luke@example.invalid>' }] };
    await route.fulfill({ response, json: board });
  });
  await page.goto('/p/demo/t/parser-escapes');
  const context = page.getByRole('region', { name: 'Context supplied' });
  await expect(context.locator('.briefing-target')).toHaveText('src/table.ts');
  await expect(context.locator('.symbol-chip')).toHaveText('◆ parseRow');
  await expect(context.locator('.annotation-card .tag')).toHaveText(['parseRow', 'whitespace']);
  await expect(context).toContainText('Preserve whitespace in parseRow.');
  await context.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${shots}/decision-context-tags-1920.png`, fullPage: true });
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

test('C-T2 early feed survives delayed initial board snapshot', async ({ page, request }) => {
  await reset(request, 'pushing');
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let snapshots = 0;
  await page.route('**/api/projects/demo', async route => {
    const response = await route.fetch(); snapshots++;
    await held; await route.fulfill({ response });
  });
  await page.goto('/p/demo');
  await expect(page.locator('.live')).toHaveText('Live');
  await expect.poll(() => snapshots).toBeGreaterThan(0);
  await request.post('/__mock/replay');
  release();
  await expect(page.getByTestId('lane-alice')).toContainText('fail · 12/14');
  await expect(page.getByRole('link', { name: /Why ffffffffff landed/ })).toBeVisible();
});

test('C-T2 initial compare snapshot retains early discussion and landing', async ({ page, request }) => {
  await reset(request, 'pushing');
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let snapshots = 0;
  await page.route('**/api/projects/demo/tasks/parser-escapes', async route => {
    const response = await route.fetch(); snapshots++;
    await held; await route.fulfill({ response });
  });
  await page.goto('/p/demo/t/parser-escapes');
  await expect(page.locator('.live')).toHaveText('Live');
  await expect.poll(() => snapshots).toBeGreaterThan(0);
  await request.post('/__mock/replay');
  release();
  await expect(page.getByText('✓ Landed bob on main')).toBeVisible();
  await expect(page.locator('.discussion')).toContainText('Agree — API stability matters more than the shorter regex.');
});

for (const scenario of ['passed', 'failed', 'wrong-sha', 'malformed'] as const) test(`C-T5 recorded publication evidence: ${scenario}`, async ({ page, request }) => {
  await reset(request, 'decided');
  await page.route('**/api/projects/demo/why/*', async route => {
    const response = await route.fetch();
    const body = await response.json();
    body.verify = { sha: scenario === 'wrong-sha' ? 'a'.repeat(40) : body.sha,
      exportRoundTrip: true, treeMatch: scenario !== 'failed', fsck: true, checkedAt: '2026-10-10T20:00:00.000Z' };
    if (scenario === 'malformed') body.verify.fsck = 'true';
    await route.fulfill({ response, json: body });
  });
  await page.goto(why);
  const evidence = page.locator('.verification');
  if (scenario === 'passed' || scenario === 'failed') {
    await expect(evidence).toContainText(`Recorded publication checks ${scenario}.`);
    await expect(evidence).toContainText('not a live Artifacts recheck');
    await expect(evidence).toContainText('2026-10-10T20:00:00.000Z');
    await expect(evidence).toContainText('Candidate SHA preservation is a separate check');
    await expect(evidence).toContainText(`Chosen tree matches main: ${scenario === 'failed' ? 'FAILED' : 'passed'}`);
  } else {
    await expect(evidence).toContainText('Unavailable from the current API');
    await expect(evidence).not.toContainText('Recorded publication checks passed');
  }
});

test('C-T6 repeated decision submit stays single-flight', async ({ page, request }) => {
  await reset(request); await choose(page);
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let attempts = 0;
  await page.route('**/decision', async route => { attempts++; await held; await route.continue(); });
  await page.getByRole('button', { name: 'Land candidate →' }).click();
  await expect(page.getByRole('button', { name: 'Landing…' })).toBeDisabled();
  await page.getByLabel('Why this candidate?').evaluate(element => {
    element.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
  expect(attempts).toBe(1); release();
  await expect(page.getByText('✓ Landed bob on main')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Decision landed' })).toBeDisabled();
  const posted = await (await request.get('/__mock/requests')).json();
  expect(posted.filter((r: { path: string }) => r.path.endsWith('/decision'))).toHaveLength(1);
});

test('C-T6 cancel reply clears target and browser history restores board and compare', async ({ page, request }) => {
  await reset(request); await page.goto('/p/demo');
  await page.getByRole('link', { name: 'parser-escapes', exact: true }).click();
  await page.getByRole('button', { name: 'Reply to reviewer' }).click();
  await page.getByLabel('Your reply').fill('Keep this as a top-level comment.');
  await page.getByRole('button', { name: 'Cancel reply' }).click();
  await expect(page.getByText('Replying to turn-review')).toHaveCount(0);
  await page.getByRole('button', { name: 'Post signed reply' }).click();
  await expect(page.locator('.discussion')).toContainText('Keep this as a top-level comment.');
  const posted = await (await request.get('/__mock/requests')).json();
  expect(posted[0].body).toEqual({ body: 'Keep this as a top-level comment.', as: 'luke' });
  await page.goBack();
  await expect(page.getByRole('heading', { name: 'demo', level: 1, exact: true })).toBeVisible();
  await page.goForward();
  await expect(page.getByLabel('Diff for bob')).toContainText('const cells');
  await expect(page.getByRole('radio', { name: /bob/ })).not.toBeChecked();
  await expect(page.getByRole('button', { name: 'Land candidate →' })).toBeDisabled();
});

test('C-T7 pending publication preserves signed choice and exposes exact retry', async ({ page, request }) => {
  const response = await request.post('/__mock/reset', { data: { fixture: 'conflict', pendingPublication: true } });
  expect(response.status()).toBe(200);
  await page.goto('/p/demo');
  await expect(page.getByRole('region', { name: 'parser-escapes' })).toContainText('PUBLICATION PENDING');
  await expect(page.getByRole('link', { name: /Why .* landed/ })).toHaveCount(0);
  await page.getByRole('link', { name: 'Retry publication' }).click();
  await expect(page.getByText('Decision recorded. Publication pending.')).toBeVisible();
  await expect(page.getByRole('link', { name: /See why/ })).toHaveCount(0);
  const saved = await (await request.get('/api/projects/demo/tasks/parser-escapes')).json();
  await expect(page.getByLabel('Why this candidate?')).toHaveValue(saved.decision.rationale);
  await expect(page.getByLabel('Why this candidate?')).toBeDisabled();
  await expect(page.getByRole('radio', { name: /bob/ })).toBeChecked();
  await expect(page.getByRole('radio', { name: /alice/ })).toBeDisabled();
  const posted = page.waitForRequest(r => r.url().endsWith('/decision') && r.method() === 'POST');
  await page.getByRole('button', { name: 'Retry publication' }).click();
  expect((await posted).postDataJSON()).toEqual({ pick: saved.decision.pick, decider: saved.decision.decider, rationale: saved.decision.rationale, expectHeads: saved.heads });
  await expect(page.getByText('✓ Landed bob on main')).toBeVisible();
  await expect(page.getByRole('link', { name: /See why/ })).toHaveAttribute('href', why);
});

test('C-T7 publish failure re-reads recorded decision before retry', async ({ page, request }) => {
  await reset(request, 'conflict', 502); await choose(page);
  await page.getByRole('button', { name: 'Land candidate →' }).click();
  await expect(page.getByText('Decision recorded. Publication pending.')).toBeVisible();
  await expect(page.getByLabel('Why this candidate?')).toBeDisabled();
  await expect(page.getByRole('link', { name: /See why/ })).toHaveCount(0);
  await request.post('/__mock/decision-status', { data: { decisionStatus: 200 } });
  await page.getByRole('button', { name: 'Retry publication' }).click();
  await expect(page.getByText('✓ Landed bob on main')).toBeVisible();
  const requests = await (await request.get('/__mock/requests')).json();
  const attempts = requests.filter((r: { path: string }) => r.path.endsWith('/decision'));
  expect(attempts).toHaveLength(2);
  expect(attempts[1].body).toEqual(attempts[0].body);
});

test('C-T8 board double-click keeps one refresh and retains the live candidate', async ({ page, request }) => {
  await reset(request);
  let socket!: import('@playwright/test').WebSocketRoute;
  await page.routeWebSocket('**/api/projects/demo/ws', ws => { socket = ws; });
  await page.goto('/p/demo');
  await expect(page.locator('.live')).toHaveText('Live');
  await expect(page.getByRole('button', { name: 'Refresh board' })).toBeEnabled();
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; }); let reads = 0;
  await page.route('**/api/projects/demo', async route => { const response = await route.fetch(); reads++; await held; await route.fulfill({ response }); });
  await page.getByRole('button', { name: 'Refresh board' }).evaluate(button => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await expect(page.getByRole('button', { name: 'Refreshing…' })).toBeDisabled();
  await expect.poll(() => reads).toBe(1);
  const current = await (await request.get('/api/projects/demo/tasks/parser-escapes')).json();
  socket.send(JSON.stringify({ type: 'candidate.ready', candidate: { ...current.candidates[1], subject: 'Latest buffered candidate' } }));
  await expect(page.getByTestId('lane-bob')).toContainText('Latest buffered candidate');
  release(); await expect(page.getByRole('button', { name: 'Refresh board' })).toBeEnabled();
  await expect(page.getByTestId('lane-bob')).toContainText('Latest buffered candidate'); expect(reads).toBe(1);
});

test('C-T8 repeated discussion submit is single-flight and freezes the pending draft', async ({ page, request }) => {
  await reset(request); await page.goto('/p/demo/t/parser-escapes');
  await page.getByLabel('Your reply').fill('Keep the public API stable.');
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; }); let attempts = 0;
  await page.route('**/turns', async route => { attempts++; await held; await route.continue(); });
  await page.getByLabel('Your reply').evaluate(element => {
    const form = element.closest('form')!;
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
  await expect(page.getByLabel('Your reply')).toBeDisabled(); await expect(page.getByLabel('Speak as')).toBeDisabled();
  await expect.poll(() => attempts).toBe(1); release();
  await expect(page.locator('.discussion .turn').filter({ hasText: 'Keep the public API stable.' })).toHaveCount(1);
  const posted = await (await request.get('/__mock/requests')).json();
  expect(posted.filter((r: { path: string }) => r.path.endsWith('/turns'))).toHaveLength(1);
});

test('C-T8 disconnect and reconnect keep the choice stale until an explicit review', async ({ page, request }) => {
  await reset(request);
  const sockets: import('@playwright/test').WebSocketRoute[] = [];
  await page.routeWebSocket('**/api/projects/demo/ws', socket => { sockets.push(socket); });
  await choose(page); await expect(page.getByRole('button', { name: 'Land candidate →' })).toBeEnabled();
  await sockets[0].close(); await expect(page.getByRole('button', { name: 'Land candidate →' })).toBeDisabled();
  await expect(page.locator('.notice.warning')).toContainText('Review the latest task state before continuing.');
  await expect(page.getByLabel('Why this candidate?')).toBeDisabled();
  await expect.poll(() => sockets.length).toBe(2); await expect(page.locator('.live')).toHaveText('Live');
  await expect(page.getByRole('button', { name: 'Land candidate →' })).toBeDisabled();
  await page.getByRole('button', { name: 'Review current candidates' }).click();
  await expect(page.getByRole('radio', { name: /bob/ })).not.toBeChecked();
  await expect(page.getByRole('button', { name: 'Land candidate →' })).toBeDisabled();
  await page.getByRole('radio', { name: /bob/ }).check();
  await expect(page.getByRole('button', { name: 'Land candidate →' })).toBeEnabled();
  const posted = await (await request.get('/__mock/requests')).json(); expect(posted).toHaveLength(0);
});

test('C-T8 lost publication response and failed recovery read require immutable retry', async ({ page, request }) => {
  await reset(request, 'conflict', 502); await choose(page); let failNextRead = false;
  await page.route('**/api/projects/demo/tasks/parser-escapes', async route => {
    if (failNextRead) { failNextRead = false; await route.fulfill({ status: 503, json: { error: 'unavailable' } }); } else await route.continue();
  });
  await page.route('**/decision', async route => { await route.fetch(); failNextRead = true; await route.abort('failed'); });
  await page.getByRole('button', { name: 'Land candidate →' }).click();
  await expect(page.getByRole('button', { name: 'Review current candidates' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Land candidate →' })).toBeDisabled();
  await page.getByRole('button', { name: 'Review current candidates' }).click();
  await expect(page.getByText('Decision recorded. Publication pending.')).toBeVisible();
  await expect(page.getByLabel('Why this candidate?')).toBeDisabled();
  await page.unroute('**/decision'); await request.post('/__mock/decision-status', { data: { decisionStatus: 200 } });
  await page.getByRole('button', { name: 'Retry publication' }).click();
  await expect(page.getByText('✓ Landed bob on main')).toBeVisible();
  const posted = await (await request.get('/__mock/requests')).json();
  const attempts = posted.filter((r: { path: string }) => r.path.endsWith('/decision'));
  expect(attempts).toHaveLength(2); expect(attempts[1].body).toEqual(attempts[0].body);
});

test('C-T8 compare review buffers discussion and landing while its snapshot is delayed', async ({ page, request }) => {
  await reset(request); const current = await (await request.get('/api/projects/demo/tasks/parser-escapes')).json();
  let socket!: import('@playwright/test').WebSocketRoute;
  await page.routeWebSocket('**/api/projects/demo/ws', ws => { socket = ws; });
  await choose(page); await expect(page.getByRole('button', { name: 'Land candidate →' })).toBeEnabled();
  socket.send(JSON.stringify({ type: 'candidate.ready', candidate: current.candidates[1] }));
  await expect(page.getByRole('button', { name: 'Review current candidates' })).toBeVisible();
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; }); let reads = 0;
  await page.route('**/api/projects/demo/tasks/parser-escapes', async route => { const response = await route.fetch(); reads++; await held; await route.fulfill({ response }); });
  await page.getByRole('button', { name: 'Review current candidates' }).click(); await expect.poll(() => reads).toBe(1);
  const decision = { task: 'parser-escapes', pick: 'bob', decider: 'luke', rationale: 'Preserve the API.', mainSha: 'f'.repeat(40), at: '2026-10-12T00:00:00Z' };
  socket.send(JSON.stringify({ type: 'discussion.posted', turn: { ...current.turns[0], id: 'buffered-turn', body: 'Context arrived during review.' } }));
  socket.send(JSON.stringify({ type: 'decision.landed', decision }));
  await expect(page.getByText('✓ Landed bob on main')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Refresh recorded decision' })).toBeDisabled();
  release(); await expect(page.getByRole('button', { name: 'Refresh recorded decision' })).toHaveCount(0);
  await expect(page.getByText('✓ Landed bob on main')).toBeVisible();
  await expect(page.locator('.discussion')).toContainText('Context arrived during review.');
});
