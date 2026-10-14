// SPDX-License-Identifier: Apache-2.0
import { test, expect } from '@playwright/test';
import type { Page, Locator } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

const evidence = process.env.TAPESTRY_EVIDENCE_DIR;
const task = '/p/demo/t/parser-escapes';
const reason = 'Keep the string[] API stable. The single pass handles escaped pipes without changing callers.';

async function atTop(page: Page, locator: Locator) {
  await locator.evaluate(node => window.scrollTo({ top: window.scrollY + node.getBoundingClientRect().top - 128, behavior: 'instant' }));
}
async function shot(page: Page, name: string) {
  await page.evaluate(async () => { await document.fonts.ready; await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); });
  if (evidence) { await mkdir(evidence, { recursive: true }); await page.screenshot({ path: `${evidence}/${name}.png` }); }
}
async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
}

test.afterEach(async ({ page }) => { await page.unrouteAll({ behavior: 'ignoreErrors' }); });

for (const theme of ['light', 'dark'] as const) for (const [width, height] of [[1280, 720], [1440, 900]]) {
  test(`tapestry surfaces at ${width}x${height}, ${theme}`, async ({ page, request }) => {
    await request.post('/__mock/reset', { data: { fixture: 'conflict' } });
    await page.setViewportSize({ width, height });
    await page.addInitScript(theme => localStorage.setItem('heddle-theme', theme), theme);
    await page.route('**/api/projects/demo', async route => {
      const response = await route.fetch(), board = await response.json();
      board.tasks[0].lanes[0].briefing = { hash: 'b'.repeat(64), omitted: 0, annotations: [
        { target: 'src/table.ts', scope: 'symbol:parseRow', annotationId: 'ann-constraint', revisionId: 'rev', kind: 'constraint', content: 'Preserve the `string[]` return type. Callers already depend on this contract.', tags: ['parseRow', 'public-api'], attribution: 'Luke <luke@example.invalid>' },
        { target: 'src/table.ts', scope: 'file', annotationId: 'ann-invariant', revisionId: 'rev', kind: 'invariant', content: 'An escaped pipe stays inside its cell; backslash parity determines whether it separates cells.', tags: ['escapes'], attribution: 'mara' },
        { target: 'src/table.ts', scope: 'module', annotationId: 'ann-rationale', revisionId: 'rev', kind: 'rationale', content: 'A single pass makes the escape rules explicit for the next person reading the parser.', attribution: 'luke' }
      ] };
      await route.fulfill({ response, json: board });
    });
    await page.route('**/api/projects/demo/tasks/parser-escapes', async route => {
      const response = await route.fetch(), data = await response.json();
      const base = data.turns[0];
      data.turns = [
        { ...base, id: 'agent-one', author: 'bob', kind: 'agent', body: 'I kept `parseRow` returning `string[]` and added the escape cases.' },
        { ...base, id: 'agent-two', author: 'bob', kind: 'agent', body: 'All fourteen parser tests pass.' },
        { ...base, id: 'human-one', author: 'luke', kind: 'human', body: 'Agreed. Keep the public API stable.' },
        { ...base, id: 'human-two', author: 'luke', kind: 'human', body: 'Please keep the reason with the code.' },
        { ...base, body: 'Bob preserves the public API and handles escaped pipes.' }
      ];
      data.review.model = '@cf/zai-org/glm-5.2';
      await route.fulfill({ response, json: data });
    });
    await page.goto(task);
    await expect(page.locator('.live')).toHaveText('Live');
    const suffix = `${width}x${height}-${theme}`;
    const discussion = page.locator('.discussion');
    await page.getByRole('link', { name: 'Discussion', exact: true }).click();
    await expect(discussion.locator('.discussion-status')).toHaveText('open');
    await expect(discussion.locator('.anchor-chip')).toHaveCount(0);
    await expect(discussion.locator('.turn')).toHaveCount(5);
    await expect(discussion.locator('.turn-agent .turn-heading')).toHaveCount(1);
    await expect(discussion.locator('.turn-human .turn-heading')).toHaveCount(1);
    await expect(discussion.locator('.turn-agent .turn-role')).toHaveText('agent');
    await expect(discussion.locator('.turn-reviewer .turn-role')).toHaveText('reviewer');
    await expect(discussion.locator('.turn-human .turn-role')).toHaveCount(0);
    await expect(discussion.locator('.turn-agent .turn-avatar')).toHaveText('◇');
    await expect(discussion.locator('.turn-human .turn-avatar')).toHaveText('L');
    await expect(discussion.locator('.turn-agent .turn-avatar')).toHaveCSS('width', '26px');
    await expect(discussion.locator('.turn-agent .turn-bubble').first()).toHaveCSS('border-top-style', 'dashed');
    await expect(discussion.locator('.turn-reviewer .turn-bubble')).toHaveCSS('border-top-style', 'dashed');
    await expect(discussion.locator('.turn-human .turn-bubble').first()).toHaveCSS('border-top-style', 'solid');
    expect(await discussion.locator('.turn-human .turn-bubble').first().evaluate(n => getComputedStyle(n).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)');
    await expect(discussion.locator('.turn-agent .turn-bubble').first()).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await expect(discussion.locator('.turn-bubble').first()).toHaveCSS('border-top-left-radius', '4px');
    await atTop(page, discussion); await noOverflow(page); await shot(page, `discussion-${suffix}`);
    // Keep reply threading functional when bylines are grouped.
    await discussion.getByRole('button', { name: 'Reply to bob' }).nth(1).click();
    await expect(discussion).toContainText('Replying to agent-two');
    await discussion.getByRole('button', { name: 'Cancel reply' }).click();

    await page.getByRole('link', { name: 'Context', exact: true }).click();
    const context = page.locator('.context-supplied'), cards = context.locator('.annotation-card');
    await expect(cards).toHaveCount(3);
    await expect(cards.locator('.annotation-heading')).toHaveText(['constraint', 'invariant', 'rationale']);
    const constraint = cards.first();
    await expect(constraint.locator('.briefing-target')).toHaveText('src/table.ts');
    await expect(constraint.locator('.symbol-chip')).toHaveText('◆ parseRow');
    await expect(constraint.locator('.rich-text')).toContainText('string[]');
    await expect(constraint.locator('.annotation-author')).toHaveText('by Luke');
    await expect(constraint.locator('.tag')).toHaveText(['parseRow', 'public-api']);
    await expect(constraint.locator('.briefing-hash')).toHaveText('bbbbbbbbbb');
    await expect(constraint.locator('.briefing-hash')).toHaveAttribute('title', 'b'.repeat(64));
    await expect(constraint.locator('.annotation-note')).toHaveCSS('border-left-width', '0px');
    await expect(cards.nth(1).locator('.annotation-scope')).toHaveText('file');
    await expect(cards.nth(1).locator('.symbol-chip')).toHaveCount(0);
    await expect(cards.nth(2).locator('.annotation-scope')).toHaveText('module');
    const colors = await cards.locator('.kind-dot').evaluateAll(nodes => nodes.map(n => getComputedStyle(n).backgroundColor));
    expect(new Set(colors).size).toBe(3);
    await expect(context).toContainText('Not briefed, as a control: bob.');
    await atTop(page, context); await noOverflow(page); await shot(page, `context-${suffix}`);

    await page.getByRole('link', { name: 'Candidates', exact: true }).click();
    const reviewer = page.locator('.reviewer');
    await atTop(page, reviewer);
    await expect(reviewer.locator('.reviewer-model')).toHaveText('GLM-5.2');
    await expect(reviewer).toContainText('Recommendation: bob');
    await expect(reviewer.locator('.review-row')).toHaveCount(2);
    await expect(reviewer.locator('.review-concerns .review-agent')).toHaveText('alice');
    await expect(reviewer.locator('.review-concerns .review-glyph')).toHaveText('–');
    await expect(reviewer.locator('.review-approve .review-agent')).toHaveText('bob');
    await expect(reviewer.locator('.review-approve .review-glyph')).toHaveText('✓');
    await expect(reviewer.getByRole('img', { name: 'approve' })).toBeVisible();
    await expect(reviewer.locator('blockquote')).toHaveText(['Changes the public API; two regression tests fail.', 'Keeps the public API; all fourteen tests pass.']);
    await expect(reviewer.locator('blockquote').first()).toHaveCSS('margin-left', '0px');
    await noOverflow(page); await shot(page, `reviewer-${suffix}`);

    await page.getByRole('link', { name: 'Captures', exact: true }).click();
    const captures = page.locator('#captures');
    await captures.getByRole('button', { name: 'Next', exact: true }).click();
    const card = captures.locator('.attribution-card');
    await expect(card.locator('dt')).toHaveText(['Task', 'State', 'Agent', 'Provider', 'Model', 'Signed by', 'Captured', 'Tests']);
    await expect(card.locator('dd')).toHaveText(['parser-escapes', 'state-bob-early', 'Bob', 'anthropic', 'sonnet', 'ed25519:bbbbbbbb…bbbbbbbb', /Oct 10, 2026/, 'pass · 14 passed / 0 failed · All parser cases pass']);
    await expect(card.locator('.attribution-signature')).not.toContainText('✓');
    await expect(captures.locator('.semantic-changes')).toContainText('Function modified: parseRow in src/table.ts');
    await expect(captures.locator('.capture-dot[aria-pressed=true]')).toHaveCount(1);
    await atTop(page, captures.locator('.capture-detail')); await noOverflow(page); await shot(page, `capture-${suffix}`);
    await captures.getByRole('button', { name: 'Previous', exact: true }).click();
    await expect(card).toContainText('state-alice-early');

    await page.getByRole('radio', { name: /bob/ }).check();
    await page.getByLabel('Why this candidate?', { exact: true }).fill(reason);
    await page.getByLabel('Point this reason at', { exact: true }).fill('src/table.ts:parseRow');
    await page.getByLabel('Tags', { exact: true }).fill('public-api, escapes');
    await page.getByRole('button', { name: 'Land candidate →', exact: true }).click();
    const notice = page.locator('.notice.landed'), recorded = notice.locator('.annotation-card');
    await expect(notice).toContainText('Landed bob on main');
    await expect(recorded.locator('.annotation-heading')).toHaveText('Reason');
    await expect(recorded.locator('.rich-text')).toHaveText(reason);
    await expect(recorded.locator('.annotation-author')).toHaveText('by luke');
    await expect(recorded.locator('.anchor-chip')).toHaveAttribute('title', 'src/table.ts:parseRow');
    await expect(recorded.locator('.symbol-chip')).toHaveText('◆ parseRow');
    await expect(recorded.locator('.tag')).toHaveText(['public-api', 'escapes']);
    await expect(discussion.locator('.discussion-status')).toHaveText('resolved');
    await expect(discussion.locator('.anchor-chip')).toHaveAttribute('title', 'src/table.ts:parseRow');
    await atTop(page, notice); await noOverflow(page); await shot(page, `landed-reason-${suffix}`);
    await notice.getByRole('link', { name: /See why .* landed/ }).click();
    const whyReason = page.locator('.narrative .annotation-card');
    await expect(whyReason.locator('.annotation-heading')).toHaveText('Reason');
    await expect(whyReason.locator('.rich-text')).toHaveText(reason);
    await expect(whyReason.locator('.tag')).toHaveText(['public-api', 'escapes']);
    await expect(whyReason.locator('.annotation-author')).toHaveText('by luke');
    await noOverflow(page); await shot(page, `why-reason-${suffix}`);
  });
}

test('absent attribution fields and decision anchors stay absent; raw model ids remain readable', async ({ page, request }) => {
  await request.post('/__mock/reset', { data: { fixture: 'decided' } });
  await page.route('**/api/projects/demo', async route => {
    const response = await route.fetch(), data = await response.json();
    delete data.agents[0].provider; delete data.agents[0].model;
    await route.fulfill({ response, json: data });
  });
  await page.route('**/captures', async route => {
    const response = await route.fetch(), data = await response.json();
    for (const lane of data.lanes) for (const capture of lane.captures) { delete capture.tests; capture.signedBy = ''; }
    await route.fulfill({ response, json: data });
  });
  await page.goto(task);
  await expect(page.locator('.discussion-status')).toHaveText('resolved');
  await expect(page.locator('.discussion .anchor-chip')).toHaveCount(0);
  await expect(page.locator('.notice.landed .anchor-chip')).toHaveCount(0);
  await expect(page.locator('.reviewer-model')).toHaveText('workers-ai/qwen-coder');
  await expect(page.locator('.attribution-card dt')).toHaveText(['Task', 'State', 'Agent', 'Captured']);
});

test('cards and thread stack on mobile and retain keyboard focus', async ({ page, request }) => {
  await request.post('/__mock/reset', { data: { fixture: 'decided' } });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(task);
  await page.getByRole('link', { name: 'Discussion', exact: true }).click();
  await page.keyboard.press('Tab');
  await page.getByRole('button', { name: 'Reply to reviewer' }).focus();
  await expect(page.getByRole('button', { name: 'Reply to reviewer' })).toHaveCSS('outline-style', 'solid');
  await page.keyboard.press('Enter');
  await expect(page.locator('.discussion')).toContainText('Replying to turn-review');
  await noOverflow(page);
  await page.getByRole('link', { name: 'Captures', exact: true }).click();
  await page.locator('#captures').getByRole('button', { name: 'Next', exact: true }).click();
  await expect(page.locator('.attribution-card')).toContainText('state-bob-early');
  await noOverflow(page);
  await page.goto('/p/demo/t/docs-readme#context');
  await expect(page.locator('.context-supplied .annotation-card')).toContainText('Document the escaped-pipe syntax');
  await noOverflow(page);
});
