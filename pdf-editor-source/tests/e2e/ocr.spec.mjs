// M11 — OCR with Tesseract.js: recognize a scanned fixture, verify, apply; find works afterwards.
import { readFileSync } from 'node:fs';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { test, expect, openApp, openFixture, pageIn, shot } from './helpers.mjs';

const findBar = (page) => page.getByRole('search', { name: 'Find in document' });
const findInput = (page) => findBar(page).getByRole('searchbox');
const counter = (page) => findBar(page).locator('.find-count');
const findState = (page) => page.evaluate(() => window.pdfEditor.app.activeTab.find?.state ?? null);
async function find(page, query) {
  if (!(await findInput(page).isVisible())) await page.keyboard.press('Control+f');
  await findInput(page).fill(query);
  await expect.poll(async () => {
    const s = await findState(page);
    return s?.query === query && s.complete;
  }).toBe(true);
}
const lastLabel = (page) => page.evaluate(() => window.pdfEditor.app.activeTab.model.history.current.label);
async function stepDone(page, label) {
  await expect.poll(() => lastLabel(page), { timeout: 30_000 }).toBe(label);
  await page.waitForFunction(() => !window.pdfEditor.app.activeTab.model.busy);
}
const run = (page) => page.evaluate(() => { window.pdfEditor.registry.getTool('ocr').run({ app: window.pdfEditor.app }); });
const verify = (page) => page.getByRole('dialog', { name: 'Check recognized text' });
const word = (page, text) => verify(page).locator('.ocr-word').filter({ has: page.locator(`xpath=self::*[starts-with(@aria-label, "${text} (")]`) });

test.describe('OCR', () => {
  test.setTimeout(120_000);
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1400, height: 900 });
    await openApp(page);
    await page.evaluate(() => window.pdfEditor.storage.clearAll());
  });

  test('recognize a scan, correct a word, apply; the find bar then locates known words', async ({ page }) => {
    await openFixture(page, 'scanned.pdf');
    await find(page, 'capybara');
    await expect(counter(page)).toHaveText('No results');
    await page.keyboard.press('Escape');

    await run(page);
    const dialog = page.getByRole('dialog', { name: 'Recognize text (OCR)' });
    await expect(dialog.getByLabel('Language')).toHaveValue('eng');
    await expect(dialog.getByLabel('Straighten (deskew)')).toBeChecked();
    await expect(dialog.getByLabel('All (2)')).toBeChecked();
    await shot(page, 'm11-ocr-dialog-light');
    await dialog.getByRole('button', { name: 'Recognize' }).click();

    await expect(verify(page)).toBeVisible({ timeout: 90_000 });
    await expect(verify(page).locator('.ocr-page-label')).toHaveText('Page 1 (1 of 2)');
    await expect(word(page, 'capybara')).toHaveCount(1);
    await expect(verify(page).locator('.ocr-word').first()).toHaveClass(/conf-high/);
    await shot(page, 'm11-verify-light');

    // Correct a word: it's remembered in the user dictionary.
    await word(page, '48213').click();
    const edit = verify(page).getByRole('textbox', { name: 'Correct word' });
    await expect(edit).toBeFocused();
    await edit.fill('48214');
    await edit.press('Enter');
    await expect(verify(page).locator('.ocr-word.corrected')).toHaveCount(1);
    await expect(verify(page).locator('.ocr-dict')).toHaveText('Your dictionary has 1 correction.');

    // Page 2 (deskewed).
    await verify(page).getByRole('button', { name: 'Next page' }).click();
    await expect(word(page, 'quetzal')).toHaveCount(1);

    await verify(page).getByRole('button', { name: 'Apply' }).click();
    await stepDone(page, 'Recognize text (OCR)');

    // The invisible text layer: searchable and selectable.
    await find(page, 'capybara');
    await expect(counter(page)).toHaveText('1 of 1');
    await find(page, 'quetzal');
    await expect(counter(page)).toHaveText('1 of 1');
    await find(page, '48214');
    await expect(counter(page)).toHaveText('1 of 1');
    await find(page, 'largest living rodent');
    await expect(counter(page)).toHaveText('1 of 1');
    await page.keyboard.press('Escape');
    await expect(pageIn(page, 1).locator('.textLayer span').filter({ hasText: 'capybara' })).toHaveCount(1);
    // …but invisible: the page still looks like the scan (no dark text pixels added where there were none).

    // Saved: another reader finds the text too.
    const download = page.waitForEvent('download');
    await page.keyboard.press('Control+s');
    const path = test.info().outputPath('ocr.pdf');
    await (await download).saveAs(path);
    const task = pdfjs.getDocument({ data: new Uint8Array(readFileSync(path)), verbosity: 0 });
    const pdf = await task.promise;
    const text = (await (await pdf.getPage(1)).getTextContent()).items.map((i) => i.str).join(' ');
    expect(text).toMatch(/The\s+capybara\s+is\s+the\s+largest/);
    await task.destroy();

    // One undo step.
    await page.keyboard.press('Control+z');
    await stepDone(page, 'Opened scanned.pdf');
    await find(page, 'capybara');
    await expect(counter(page)).toHaveText('No results');
  });

  test('dictionary corrections apply to later runs; re-OCR region and page; cancel changes nothing', async ({ page }) => {
    await page.evaluate(async () => {
      const { setPref } = await import('@app/core/prefs.js');
      setPref('ocr.dictionary', { corrections: { REPORT: 'RECORD' } });
    });
    await openFixture(page, 'scanned.pdf');
    await run(page);
    const dialog = page.getByRole('dialog', { name: 'Recognize text (OCR)' });
    await dialog.getByLabel('Current page (1)').check();
    await dialog.getByRole('button', { name: 'Recognize' }).click();
    await expect(verify(page)).toBeVisible({ timeout: 90_000 });
    await expect(verify(page).locator('.ocr-page-label')).toHaveText('Page 1 (1 of 1)');
    await expect(word(page, 'RECORD')).toHaveClass(/corrected/);

    // Re-OCR an area: draw a box around the second line.
    const before = await verify(page).locator('.ocr-word').count();
    await verify(page).getByRole('button', { name: 'Re-OCR an area' }).click();
    const box = await word(page, 'capybara').boundingBox();
    const fig = await verify(page).locator('.ocr-figure').boundingBox();
    await page.mouse.move(fig.x + 20, box.y - 10);
    await page.mouse.down();
    await page.mouse.move(fig.x + fig.width - 20, box.y + box.height + 10, { steps: 5 });
    await page.mouse.up();
    await expect(page.locator('.toast').filter({ hasText: /Re-recognized \d+ words/ })).toBeVisible({ timeout: 30_000 });
    await expect(word(page, 'capybara')).toHaveCount(1);
    expect(await verify(page).locator('.ocr-word').count()).toBe(before);

    await verify(page).getByRole('button', { name: 'Re-OCR page' }).click();
    await expect(verify(page).locator('.ocr-busy')).toBeHidden({ timeout: 30_000 });
    await expect(word(page, 'capybara')).toHaveCount(1);

    await verify(page).getByRole('button', { name: 'Cancel' }).click();
    await expect(verify(page)).toBeHidden();
    expect(await lastLabel(page)).toBe('Opened scanned.pdf');
  });

  test('pages that already have text are skipped', async ({ page }) => {
    await openFixture(page, 'multipage.pdf');
    await run(page);
    const dialog = page.getByRole('dialog', { name: 'Recognize text (OCR)' });
    await expect(dialog.getByLabel('All (12)')).toBeChecked();
    await dialog.getByRole('button', { name: 'Recognize' }).click();
    await expect(page.locator('.toast').filter({ hasText: 'already have text' })).toBeVisible();
    expect(await lastLabel(page)).toBe('Opened multipage.pdf');
  });

  test('screenshots: dark theme', async ({ page }) => {
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
    await openFixture(page, 'scanned.pdf');
    await run(page);
    await shot(page, 'm11-ocr-dialog-dark');
    await page.getByRole('dialog', { name: 'Recognize text (OCR)' }).getByRole('button', { name: 'Recognize' }).click();
    await expect(verify(page)).toBeVisible({ timeout: 90_000 });
    await verify(page).getByRole('button', { name: 'Next page' }).click();
    await expect(word(page, 'quetzal')).toHaveCount(1);
    await shot(page, 'm11-verify-dark');
    await verify(page).getByRole('button', { name: 'Cancel' }).click();
  });
});
