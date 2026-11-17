import { readFileSync } from 'node:fs';
import * as fflate from 'fflate';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { test, expect, openApp, openFixture, fixture, shot } from './helpers.mjs';

const combineDialog = (page) => page.getByRole('dialog', { name: 'Combine files' });
const rows = (page) => combineDialog(page).locator('.combine-row');

/** Outline of the active tab as nested [title, children] pairs, plus page index of each entry. */
function activeOutline(page) {
  return page.evaluate(async () => {
    const doc = window.pdfEditor.app.activeTab.pdf;
    const walk = async (items) => Promise.all((items ?? []).map(async (i) => [
      i.title,
      Array.isArray(i.dest) ? await doc.getPageIndex(i.dest[0]) : null,
      await walk(i.items),
    ]));
    return walk(await doc.getOutline());
  });
}

const firstTexts = (page) => page.evaluate(async () => {
  const doc = window.pdfEditor.app.activeTab.pdf;
  const out = [];
  for (let i = 1; i <= doc.numPages; i++) out.push((await (await doc.getPage(i)).getTextContent()).items.find((x) => x.str.trim())?.str ?? '');
  return out;
});

async function openTool(page, id) {
  await page.locator(`.tool-row[data-tool="${id}"]`).click();
}

test.describe('combine', () => {
  test('files from disk and open tabs, reordered, with ranges and a bookmark per file', async ({ page }) => {
    await openApp(page);
    await openFixture(page, 'outline.pdf');
    await openTool(page, 'combine-files');
    // The active document is added first.
    await expect(rows(page)).toHaveCount(1);
    await expect(rows(page).first()).toContainText('outline.pdf');
    await expect(rows(page).first()).toContainText('10 pages');

    await combineDialog(page).locator('#combine-file-input').setInputFiles([fixture('multipage.pdf'), fixture('mixed-sizes.pdf')]);
    await expect(rows(page)).toHaveCount(3);
    // Move multipage.pdf to the top with its ↑ button.
    await combineDialog(page).getByRole('button', { name: 'Move multipage.pdf up' }).click();
    await expect(rows(page).locator('.combine-name')).toHaveText(['multipage.pdf', 'outline.pdf', 'mixed-sizes.pdf']);
    // Drag mixed-sizes.pdf above outline.pdf.
    await rows(page).nth(2).dragTo(rows(page).nth(1), { targetPosition: { x: 40, y: 4 } });
    await expect(rows(page).locator('.combine-name')).toHaveText(['multipage.pdf', 'mixed-sizes.pdf', 'outline.pdf']);
    // Remove mixed-sizes.pdf.
    await combineDialog(page).getByRole('button', { name: 'Remove mixed-sizes.pdf' }).click();
    await expect(rows(page)).toHaveCount(2);

    // A bad range is caught, then fixed.
    await combineDialog(page).getByLabel('Pages of multipage.pdf').fill('1-3, 99');
    await combineDialog(page).getByRole('button', { name: 'Combine' }).click();
    await expect(combineDialog(page).getByRole('alert')).toContainText('“99” isn’t a valid page range for multipage.pdf');
    await combineDialog(page).getByLabel('Pages of multipage.pdf').fill('1-3');
    await expect(combineDialog(page).getByLabel('Add a bookmark for each file')).toBeChecked();
    await combineDialog(page).getByRole('button', { name: 'Combine' }).click();

    await expect(combineDialog(page)).toBeHidden();
    await expect(page.locator('.tab-item.active .tab-name')).toHaveText('Combined.pdf');
    await expect(page.locator('.tab-item.active .tab-dirty')).toBeVisible();
    expect(await page.evaluate(() => window.pdfEditor.app.activeTab.pdf.numPages)).toBe(13);
    const outline = await activeOutline(page);
    expect(outline.map(([title, p]) => [title, p])).toEqual([['multipage', 0], ['outline', 3]]);
    const nested = outline[1][2];
    expect(nested.map(([title, p]) => [title, p])).toEqual([['Introduction', 3], ['Part One', 4], ['Part Two', 9], ['Appendix', 12]]);
    expect(nested[1][2].map(([title, p]) => [title, p])).toEqual([['Chapter 1', 5], ['Chapter 2', 7]]);
    await expect(page.locator('.toast')).toContainText('Combined 2 files (13 pages)');
  });

  test('without file bookmarks; form fields and metadata carry over', async ({ page }) => {
    await openApp(page);
    await openTool(page, 'combine-files');
    await combineDialog(page).locator('#combine-file-input').setInputFiles([fixture('forms.pdf'), fixture('outline.pdf'), fixture('forms.pdf')]);
    await expect(rows(page)).toHaveCount(3);
    await combineDialog(page).getByLabel('Add a bookmark for each file').uncheck();
    await combineDialog(page).getByLabel('File name').fill('merged');
    await combineDialog(page).getByRole('button', { name: 'Combine' }).click();
    await expect(page.locator('.tab-item.active .tab-name')).toHaveText('merged.pdf');
    const info = await page.evaluate(async () => {
      const doc = window.pdfEditor.app.activeTab.pdf;
      const fields = await doc.getFieldObjects();
      return { pages: doc.numPages, fields: fields ? [...fields.keys()].sort() : [], title: (await doc.getMetadata()).info.Title };
    });
    expect(info.pages).toBe(12);
    expect(info.fields).toHaveLength(16);
    expect(info.fields).toContain('full_name_2');
    expect(info.title).toBe('AcroForm with every field type'); // first file's metadata
    // The source outline sits at the top level, pointing at its pages (shifted by 1).
    expect((await activeOutline(page)).map(([title, p]) => [title, p])).toEqual([
      ['Introduction', 1], ['Part One', 2], ['Part Two', 7], ['Appendix', 10],
    ]);
  });

  test('protected files are refused; cancel stops a running combine', async ({ page }) => {
    test.setTimeout(60_000);
    await openApp(page);
    await openTool(page, 'combine-files');
    await combineDialog(page).locator('#combine-file-input').setInputFiles(fixture('encrypted.pdf'));
    await expect(combineDialog(page).getByRole('alert')).toHaveText('“encrypted.pdf” is password-protected and can’t be combined.');
    await expect(rows(page)).toHaveCount(0);
    await expect(combineDialog(page).getByRole('button', { name: 'Combine' })).toBeDisabled();

    await combineDialog(page).locator('#combine-file-input').setInputFiles([fixture('large.pdf'), fixture('large.pdf'), fixture('large.pdf'), fixture('large.pdf')]);
    await expect(rows(page)).toHaveCount(4);
    await combineDialog(page).getByRole('button', { name: 'Combine' }).click();
    const bar = combineDialog(page).getByRole('progressbar');
    await expect(bar).toBeVisible();
    await combineDialog(page).locator('.job-progress').getByRole('button', { name: 'Cancel' }).click();
    await expect(page.locator('.toast')).toContainText('Cancelled.');
    await expect(bar).toBeHidden();
    await expect(page.getByRole('tab')).toHaveCount(0);
    // The dialog is usable again: combine just two small ranges.
    for (let i = 0; i < 3; i++) await combineDialog(page).getByRole('button', { name: 'Remove large.pdf' }).first().click();
    await combineDialog(page).getByLabel('Pages of large.pdf').fill('1-2');
    await combineDialog(page).getByRole('button', { name: 'Combine' }).click();
    await expect(page.getByRole('tab')).toHaveCount(1);
    expect(await page.evaluate(() => window.pdfEditor.app.activeTab.pdf.numPages)).toBe(2);
  });

  test('the open document’s unsaved edits are included', async ({ page }) => {
    await openApp(page);
    await openFixture(page, 'multipage.pdf');
    await page.evaluate(() => window.pdfEditor.app.rotateCurrentPage(90));
    await expect(page.locator('.tab-item.active .tab-dirty')).toBeVisible();
    await openTool(page, 'combine-files');
    await combineDialog(page).getByRole('button', { name: 'Combine' }).click();
    await expect(page.getByRole('tab')).toHaveCount(2);
    const rot = await page.evaluate(async () => (await window.pdfEditor.app.activeTab.pdf.getPage(1)).rotate);
    expect(rot).toBe(90);
  });
});

test.describe('extract', () => {
  test('by range string, and from the organizer selection', async ({ page }) => {
    await openApp(page);
    await openFixture(page, 'outline.pdf');
    await openTool(page, 'extract-pages');
    const dialog = page.getByRole('dialog', { name: 'Extract pages' });
    await expect(dialog.getByLabel('Pages to extract')).toHaveValue('1'); // current page
    await dialog.getByLabel('Pages to extract').fill('2-3, 0');
    await dialog.getByRole('button', { name: 'Extract' }).click();
    await expect(dialog.getByRole('alert')).toContainText('“0” isn’t a valid page range');
    await dialog.getByLabel('Pages to extract').fill('2-3, 6');
    await dialog.getByRole('button', { name: 'Extract' }).click();
    await expect(page.locator('.tab-item.active .tab-name')).toHaveText('outline (pages 2-3, 6).pdf');
    expect(await firstTexts(page)).toEqual(['Part One', 'Chapter 1', 'Section 2.1']);
    // Bookmarks for the extracted pages come along.
    expect((await activeOutline(page)).map(([t]) => t)).toEqual(['Part One']);

    // From the organizer's selection.
    await page.getByRole('tab', { name: 'outline.pdf', exact: true }).click();
    await openTool(page, 'organize-pages');
    await page.locator('.org-tile[data-index="4"]').click();
    await page.locator('.org-tile[data-index="9"]').click({ modifiers: ['Control'] });
    await openTool(page, 'extract-pages');
    await expect(dialog.getByLabel('Pages to extract')).toHaveValue('5, 10');
    await dialog.getByLabel('Pages to extract').press('Enter');
    await expect(page.locator('.tab-item.active .tab-name')).toHaveText('outline (pages 5, 10).pdf');
    expect(await firstTexts(page)).toEqual(['Chapter 2', 'Appendix']);
  });
});

test.describe('split', () => {
  async function splitAndUnzip(page, setup) {
    await openTool(page, 'split-document');
    const dialog = page.getByRole('dialog', { name: /^Split “/ });
    await setup(dialog);
    const download = page.waitForEvent('download');
    await dialog.getByRole('button', { name: 'Split and download .zip' }).click();
    const file = await download;
    const path = test.info().outputPath(file.suggestedFilename());
    await file.saveAs(path);
    const files = fflate.unzipSync(new Uint8Array(readFileSync(path)));
    const out = {};
    for (const [name, bytes] of Object.entries(files)) {
      const doc = await pdfjs.getDocument({ data: bytes, verbosity: 0 }).promise;
      const texts = [];
      for (let i = 1; i <= doc.numPages; i++) texts.push((await (await doc.getPage(i)).getTextContent()).items[0]?.str);
      out[name] = { pages: doc.numPages, texts, outline: (await doc.getOutline() ?? []).map((i) => [i.title, i.items.map((c) => c.title)]) };
    }
    return { zipName: file.suggestedFilename(), files: out };
  }

  test('every N pages', async ({ page }) => {
    await openApp(page);
    await openFixture(page, 'multipage.pdf');
    const { zipName, files } = await splitAndUnzip(page, async (dialog) => {
      await dialog.getByLabel('Pages per file').fill('5');
      await expect(dialog.locator('.split-preview')).toHaveText('Creates 3 files: 1-5 · 6-10 · 11-12');
    });
    expect(zipName).toBe('multipage-split.zip');
    expect(Object.keys(files)).toEqual(['multipage-01-pages-1-5.pdf', 'multipage-02-pages-6-10.pdf', 'multipage-03-pages-11-12.pdf']);
    expect(Object.values(files).map((f) => f.pages)).toEqual([5, 5, 2]);
    expect(files['multipage-03-pages-11-12.pdf'].texts).toEqual(['Page 11 of 12', 'Page 12 of 12']);
    await expect(page.locator('.toast')).toContainText('Split into 3 files');
  });

  test('before chosen pages', async ({ page }) => {
    await openApp(page);
    await openFixture(page, 'multipage.pdf');
    const { files } = await splitAndUnzip(page, async (dialog) => {
      await dialog.getByLabel('Start a new file at these pages').fill('1');
      await expect(dialog.locator('.split-preview')).toContainText('Enter page numbers between 2 and 12');
      await expect(dialog.getByRole('button', { name: 'Split and download .zip' })).toBeDisabled();
      await dialog.getByLabel('Start a new file at these pages').fill('4, 9');
    });
    expect(Object.values(files).map((f) => f.pages)).toEqual([3, 5, 4]);
  });

  test('by top-level bookmarks, each part keeping its outline', async ({ page }) => {
    await openApp(page);
    await openFixture(page, 'outline.pdf');
    const { files } = await splitAndUnzip(page, async (dialog) => {
      await dialog.getByRole('radio', { name: 'At each top-level bookmark' }).check();
      await expect(dialog).toContainText('4 bookmarks');
    });
    expect(Object.keys(files)).toEqual(['outline-01-introduction.pdf', 'outline-02-part-one.pdf', 'outline-03-part-two.pdf', 'outline-04-appendix.pdf']);
    expect(Object.values(files).map((f) => f.pages)).toEqual([1, 5, 3, 1]);
    expect(files['outline-02-part-one.pdf'].outline).toEqual([['Part One', ['Chapter 1', 'Chapter 2']]]);
  });

  test('documents without bookmarks can’t split by them', async ({ page }) => {
    await openApp(page);
    await openFixture(page, 'multipage.pdf');
    await openTool(page, 'split-document');
    await expect(page.getByRole('radio', { name: /this document has none/ })).toBeDisabled();
  });
});

test('screenshots: combine and split in light and dark', async ({ page }) => {
  for (const theme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: theme });
    await openApp(page);
    await openFixture(page, 'outline.pdf');
    await openTool(page, 'combine-files');
    await combineDialog(page).locator('#combine-file-input').setInputFiles([fixture('multipage.pdf'), fixture('mixed-sizes.pdf')]);
    await combineDialog(page).getByLabel('Pages of multipage.pdf').fill('1-3, 7');
    await shot(page, `m6-combine-${theme}`);
    await page.keyboard.press('Escape');
    await openTool(page, 'split-document');
    await page.getByRole('radio', { name: 'At each top-level bookmark' }).check();
    await shot(page, `m6-split-${theme}`);
    await page.keyboard.press('Escape');
  }
});
