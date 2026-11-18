// M12 — final check: dist/pdf-editor.html from file:// in a brand-new browser
// profile, like a first-time user: it starts, follows the system theme, opens
// and edits a PDF, remembers it in Recent files across a restart, and makes no
// network requests except pinned library downloads from the CDN.
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, extname } from 'node:path';
import { chromium } from 'playwright';
import { test, expect } from '@playwright/test';
import { APP_URL, MIME, fixture, resolveCdn } from './helpers.mjs';
import { CDN_BASE } from '../../src/core/libs.config.js';

test('fresh profile, file:// — the whole app works end to end', async () => {
  test.setTimeout(120_000);
  const profile = mkdtempSync(join(tmpdir(), 'pdf-editor-profile-'));
  const requests = [];
  const problems = [];
  const launch = async () => {
    const ctx = await chromium.launchPersistentContext(profile, { colorScheme: 'dark', viewport: { width: 1280, height: 800 } });
    await ctx.route(/^https?:\/\//, async (route) => {
      const url = route.request().url();
      requests.push(url);
      const r = url.startsWith(`${CDN_BASE}/`) ? resolveCdn(url) : { error: `unexpected request ${url}` };
      if (r.error) {
        problems.push(r.error);
        return route.abort('blockedbyclient');
      }
      return route.fulfill({ status: 200, body: readFileSync(r.file), headers: { 'content-type': MIME[extname(r.file)] ?? 'application/octet-stream', 'access-control-allow-origin': '*' } });
    });
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    page.on('console', (m) => {
      if (m.type() === 'error' || m.text().startsWith('[i18n] missing')) problems.push(m.text());
    });
    page.on('pageerror', (e) => problems.push(e.message));
    await page.goto(APP_URL);
    await page.waitForSelector('html[data-ready="true"]');
    return { ctx, page };
  };
  try {
    let { ctx, page } = await launch();
    // First run: follows the system (dark) theme, shows the home screen.
    expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).not.toBe('rgb(246, 247, 248)');
    await expect(page.locator('.home-privacy')).toHaveText('Your files never leave this device');
    expect(await page.evaluate(() => window.pdfEditor.version)).toBe('1.0.0');

    // Open, find, edit (rotate), undo, save.
    await page.setInputFiles('#file-input', fixture('multipage.pdf'));
    await page.waitForSelector('.page[data-page-number="1"][data-state="rendered"]');
    await page.keyboard.press('Control+f');
    await page.getByRole('search', { name: 'Find in document' }).getByRole('searchbox').fill('quokka');
    await expect(page.locator('.find-count')).toHaveText('1 of 4');
    await page.keyboard.press('Escape');
    await page.evaluate(() => window.pdfEditor.app.rotateCurrentPage(90));
    await expect.poll(() => page.evaluate(() => window.pdfEditor.app.activeTab.model.history.current.label)).toBe('Rotate page 2'); // the find moved to page 2
    const download = page.waitForEvent('download');
    await page.keyboard.press('Control+s');
    expect((await download).suggestedFilename()).toMatch(/\.pdf$/);
    // Every tool is built; the accessibility checker runs.
    expect(await page.evaluate(() => window.pdfEditor.registry.listTools().every((t) => t.status === 'ready'))).toBe(true);
    await page.evaluate(() => { window.pdfEditor.registry.getTool('accessibility-check').run({ app: window.pdfEditor.app }); });
    await expect(page.getByRole('dialog', { name: 'Accessibility check' }).locator('.a11y-summary')).toContainText('passed');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(800); // let IndexedDB writes (recent files) finish
    await ctx.close();

    // Restart with the same profile: Recent files remembers the document.
    ({ ctx, page } = await launch());
    await expect(page.locator('#home .recents')).toContainText('multipage.pdf');
    await ctx.close();

    expect(problems).toEqual([]);
    // Only pinned CDN library files were requested.
    for (const url of requests) expect(url.startsWith(`${CDN_BASE}/`), url).toBe(true);
  } finally {
    rmSync(profile, { recursive: true, force: true });
  }
});
