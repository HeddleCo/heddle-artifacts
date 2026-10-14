// SPDX-License-Identifier: Apache-2.0
import { test, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

for (const theme of ['light', 'dark']) {
  test(`read-only visitors see every task without a stale banner in ${theme}`, async ({ page, request }) => {
    await page.addInitScript(t => localStorage.setItem('heddle-theme', t), theme);
    let closed = 0;
    page.on('websocket', socket => socket.on('close', () => closed++));
    for (const fixture of ['decided', 'conflict', 'pushing']) {
      const reset = await request.post('/__mock/reset', { data: { fixture, feedDenied: true } });
      expect(reset.ok()).toBe(true);
      const project = await (await request.get('/api/projects/demo')).json();
      for (const task of project.tasks) {
        const previousClosed = closed;
        await page.goto(`/p/demo/t/${task.slug}`);
        await expect(page.locator('.live')).toHaveText('Read-only');
        await expect(page.locator('.decision')).toBeVisible();
        // A second rejected handshake proves retry callbacks cannot introduce a warning.
        await expect.poll(() => closed).toBeGreaterThanOrEqual(previousClosed + 2);
        if (fixture === 'decided' && task.slug === 'parser-escapes' && process.env.STALE_STATE_EVIDENCE_PREFIX) {
          const dir = process.env.UI_SCREENSHOT_DIR || 'evidence/read-only';
          await mkdir(dir, { recursive: true });
          await page.evaluate(() => document.fonts.ready);
          await page.screenshot({ path: `${dir}/${process.env.STALE_STATE_EVIDENCE_PREFIX}-${theme}.png`, animations: 'disabled' });
        }
        await expect(page.locator('.notice.warning')).toHaveCount(0);
        await expect(page.getByLabel('Why this candidate?')).toBeDisabled();
      }
    }
  });

  test(`fragment sections have no outline and controls keep keyboard focus in ${theme}`, async ({ page, request }) => {
    await page.addInitScript(t => localStorage.setItem('heddle-theme', t), theme);
    await request.post('/__mock/reset', { data: { fixture: 'conflict' } });
    await page.goto('/p/demo/t/parser-escapes');
    await expect(page.locator('.live')).toHaveText('Live');
    await expect(page.getByLabel('Why this candidate?')).toBeEnabled();
    const tabs = page.getByRole('navigation', { name: 'Task sections' });
    for (const [name, id] of [['Captures', 'captures'], ['Discussion', 'discussion'], ['Context', 'context'], ['Candidates', 'candidates']]) {
      const link = tabs.getByRole('link', { name, exact: true });
      await link.focus(); await page.keyboard.press('Enter');
      const section = page.locator(`#${id}`);
      await section.evaluate(element => element.focus());
      await expect(section).toBeFocused();
      await expect(section).toHaveCSS('outline-style', 'none');
    }
    await page.evaluate(() => { location.hash = 'decision'; document.getElementById('decision')!.focus(); });
    await expect(page.locator('#decision')).toBeFocused();
    await expect(page.locator('#decision')).toHaveCSS('outline-style', 'none');
    for (const control of [tabs.getByRole('link', { name: 'Captures', exact: true }), page.locator('.capture-dot').first(), page.getByLabel('Why this candidate?'), page.getByLabel('Point this reason at'), page.locator('.decision select')]) {
      await control.focus();
      await expect(control).toBeFocused();
      await expect(control).toHaveCSS('outline-style', 'solid');
      await expect(control).toHaveCSS('outline-width', '2px');
    }
  });
}
