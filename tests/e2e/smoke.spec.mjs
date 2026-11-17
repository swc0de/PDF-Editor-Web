import { test, expect, openApp, shot } from './helpers.mjs';
import { LIBS } from '../../src/core/libs.config.js';

test('loads from file:// with the right title and no console errors', async ({ page }) => {
  await openApp(page);
  await expect(page).toHaveTitle('PDF Editor');
  await expect(page.locator('.brand-name')).toHaveText('PDF Editor');
  await expect(page.getByRole('banner')).toBeVisible();
  await expect(page.locator('#app')).not.toHaveAttribute('aria-busy');
  await expect(page.locator('.home-privacy')).toHaveText('Your files never leave this device');
});

// Tools built so far; everything else must still say "Coming soon".
const READY = ['read-mode'];

test('tool registry holds the complete catalogue; unbuilt tools are "Coming soon"', async ({ page }) => {
  await openApp(page);
  const info = await page.evaluate(() => {
    const { registry } = window.pdfEditor;
    return {
      categories: registry.CATEGORIES,
      tools: registry.listTools().map((t) => ({
        id: t.id, category: t.category, status: t.status, label: t.label, icon: t.icon,
        hasRun: typeof t.run === 'function', milestone: t.milestone,
      })),
    };
  });
  expect(info.categories).toEqual(['read', 'find', 'organize', 'combine', 'protect', 'forms', 'ocr', 'everywhere']);
  expect(info.tools.length).toBeGreaterThanOrEqual(25);
  for (const category of info.categories) {
    expect(info.tools.some((t) => t.category === category), `category ${category} has tools`).toBe(true);
  }
  for (const tool of info.tools) {
    const ready = READY.includes(tool.id);
    expect(tool.status, tool.id).toBe(ready ? 'ready' : 'soon');
    expect(tool.hasRun, tool.id).toBe(ready);
    expect(tool.milestone, tool.id).toMatch(/^M\d+$/);
  }
  // Every tool appears on the home catalogue with a badge and a real label.
  const cards = page.locator('.catalogue .tool-card');
  await expect(cards).toHaveCount(info.tools.length);
  await expect(page.locator('.catalogue .tool-card .badge')).toHaveCount(info.tools.length - READY.length);
  await expect(page.locator('.catalogue .tool-card .badge').first()).toHaveText('Coming soon');
  const labels = await page.locator('.catalogue .tool-label').allTextContents();
  for (const label of labels) expect(label).not.toMatch(/^tool\./); // i18n key leaked
  // 8 category headings in order
  await expect(page.locator('.category-title')).toHaveText([
    'Read', 'Find', 'Organize', 'Combine & split', 'Protect', 'Forms & layers', 'Scan & OCR', 'Everywhere',
  ]);
});

test('runTool refuses tools that are not built yet', async ({ page }) => {
  await openApp(page);
  const result = await page.evaluate(() => window.pdfEditor.registry.runTool('organize-pages'));
  expect(result).toEqual({ ok: false, reason: 'soon' });
  // Clicking a "Coming soon" card does nothing harmful.
  // (force: Playwright won't click aria-disabled elements by default)
  await page.locator('[data-tool="organize-pages"]').first().click({ force: true });
  await expect(page.locator('.toast')).toContainText('“Organize pages” is coming soon.');
  await expect(page.locator('#home')).toBeVisible();
});

test('first run follows prefers-color-scheme; the toggle is remembered', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await openApp(page);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.getByRole('button', { name: 'Switch to light theme' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.reload();
  await page.waitForSelector('html[data-ready="true"]');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  // Background actually comes from the theme tokens.
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(bg).toBe('rgb(246, 247, 248)');
});

test('pinned CDN libraries load (pdf.js, pdf-lib, fflate)', async ({ page }) => {
  await openApp(page);
  const result = await page.evaluate(async () => {
    const { libs } = window.pdfEditor;
    const [pdfjs, pdfLib, fflate] = await Promise.all([libs.loadPdfjs(), libs.loadPdfLib(), libs.loadFflate()]);
    const doc = await pdfLib.PDFDocument.create();
    doc.addPage();
    const bytes = await doc.save();
    return {
      pdfjsVersion: pdfjs.version,
      pdfLibBytes: bytes.length,
      zipped: fflate.zipSync({ 'a.txt': new TextEncoder().encode('hi') }).length > 0,
    };
  });
  expect(result.pdfjsVersion).toBe(LIBS.pdfjs.version);
  expect(result.pdfLibBytes).toBeGreaterThan(100);
  expect(result.zipped).toBe(true);
});

test('screenshots: home in light and dark', async ({ page }) => {
  for (const theme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: theme });
    await openApp(page);
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await shot(page, `m0-home-${theme}`);
    await page.locator('.catalogue').scrollIntoViewIfNeeded();
    await shot(page, `m0-catalogue-${theme}`);
  }
});
