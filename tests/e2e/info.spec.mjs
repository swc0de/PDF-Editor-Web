import { readFileSync } from 'node:fs';
import { PDFDocument } from 'pdf-lib';
import { test, expect, openApp, openFixture, fixture, pageIn, manifest, shot } from './helpers.mjs';

const panel = (page) => page.locator('#side-panel');
const lastLabel = (page) => page.evaluate(() => window.pdfEditor.app.activeTab.model.history.current.label);
const stepDone = (page, label) => expect.poll(() => lastLabel(page)).toBe(label);

const PANEL_IDS = { 'Document Properties': 'properties', Attachments: 'attachments', Layers: 'layers' };
/** Open a side panel (the rail button would toggle it closed if already open). */
async function showPanel(page, name) {
  await page.evaluate((id) => window.pdfEditor.app.showPanel(id), PANEL_IDS[name]);
  await expect(panel(page).locator('.side-panel-title')).toHaveText(name);
}

/** Fraction of green pixels on page 1's canvas (the "visible layer" box is green, the hidden one red). */
const colours = (page) => page.evaluate(() => {
  const c = document.querySelector('.viewer-host:not([hidden]) .page[data-page-number="1"] .page-canvas');
  const { data } = c.getContext('2d').getImageData(0, 0, c.width, c.height);
  let green = 0;
  let red = 0;
  for (let i = 0; i < data.length; i += 4 * 13) {
    if (data[i + 1] > 100 && data[i] < 60) green++;
    if (data[i] > 150 && data[i + 1] < 40) red++;
  }
  return { green: green > 50, red: red > 50 };
});

test.describe('document properties', () => {
  test('shows metadata, sizes, fonts and security; edits are one undo step and are saved', async ({ page }) => {
    await openApp(page);
    await openFixture(page, 'fonts.pdf');
    await page.locator('.tool-row[data-tool="properties"]').click();
    const p = panel(page);
    await expect(p.getByLabel('Title')).toHaveValue('Fonts sample');
    await expect(p.getByLabel('Author')).toHaveValue('PDF Editor test suite');
    const fact = (name) => p.locator('dt', { hasText: new RegExp(`^${name}$`) }).locator('xpath=following-sibling::dd[1]');
    await expect(fact('Pages')).toHaveText('1');
    await expect(fact('Page size')).toHaveText('A4 portrait');
    await expect(fact('PDF version')).toHaveText('1.7');
    await expect(fact('Producer')).toHaveText('pdf-lib (tests/make-fixtures.mjs)');
    await expect(fact('Tagged PDF')).toHaveText('No');
    await expect(fact('Encrypted')).toHaveText('No');
    await expect(fact('Permissions')).toHaveText('No restrictions');
    const fonts = p.locator('.font-item');
    await expect(fonts).toHaveCount(2);
    await expect(fonts.filter({ hasText: 'DMMono-Regular' }).locator('.font-embed')).toHaveText(/^Embedded/);
    await expect(fonts.filter({ hasText: 'Helvetica' }).locator('.font-embed')).toHaveText('Not embedded');

    // Edit → Apply → one undo step.
    await p.getByLabel('Title').fill('A better title');
    await p.getByLabel('Keywords').fill('alpha, beta');
    await p.getByRole('button', { name: 'Apply' }).click();
    await stepDone(page, 'Edit document properties');
    await expect(p.getByLabel('Title')).toHaveValue('A better title');
    await page.keyboard.press('Control+z');
    await expect(p.getByLabel('Title')).toHaveValue('Fonts sample');
    await page.keyboard.press('Control+Shift+Z');
    await expect(p.getByLabel('Title')).toHaveValue('A better title');

    const download = page.waitForEvent('download');
    await page.keyboard.press('Control+s');
    const path = test.info().outputPath('meta.pdf');
    await (await download).saveAs(path);
    const saved = await PDFDocument.load(readFileSync(path), { updateMetadata: false });
    expect(saved.getTitle()).toBe('A better title');
    expect(saved.getKeywords()).toBe('alpha beta');
    expect(saved.getAuthor()).toBe('PDF Editor test suite');
  });

  test('mixed page sizes, field / layer / attachment counts link to their panels', async ({ page }) => {
    await openApp(page);
    await openFixture(page, 'mixed-sizes.pdf');
    await showPanel(page, 'Document Properties');
    const sizes = panel(page).locator('.props-sizes li');
    await expect(sizes).toHaveText(['A4 portrait × 1', 'Letter portrait × 1', 'A5 landscape × 1', 'Legal portrait × 1', '5.56 × 5.56 in (141 × 141 mm) × 1', 'Letter landscape × 1']);

    await openFixture(page, 'forms.pdf');
    await expect(panel(page).getByRole('button', { name: '8 fields' })).toBeVisible();
    await openFixture(page, 'layers.pdf');
    await panel(page).getByRole('button', { name: '2 layers' }).click();
    await expect(panel(page).locator('.side-panel-title')).toHaveText('Layers');
  });

  test('permissions of a restricted PDF; encrypted documents are read-only', async ({ page }) => {
    test.skip(!manifest['restricted.pdf'], 'no restricted fixture');
    await openApp(page);
    await openFixture(page, 'restricted.pdf');
    await showPanel(page, 'Document Properties');
    const p = panel(page);
    const dd = (name) => p.locator('dt', { hasText: new RegExp(`^${name}$`) }).locator('xpath=following-sibling::dd[1]');
    await expect(dd('Encrypted')).toContainText('opens without a password');
    await expect(p.locator('.props-perms li.denied')).toContainText(['Printing', 'High-quality printing', 'Changing the document']);
    await expect(p.locator('.props-perms li.allowed')).toContainText(['Copying text and images', 'Content for accessibility']);
    await expect(p.getByLabel('Title')).toBeDisabled();
    await expect(p.locator('.props-note')).toContainText('can’t be edited until you remove the protection');
    await expect(p.locator('.props-fonts')).toContainText('aren’t available for protected PDFs');
  });
});

test.describe('attachments', () => {
  test('list, open a PDF attachment, save others, add and remove (undoable)', async ({ page }) => {
    await openApp(page);
    await openFixture(page, 'attachment.pdf');
    await page.locator('.tool-row[data-tool="attachments"]').click();
    const items = panel(page).locator('.attachment');
    await expect(items).toHaveCount(2);
    const notes = items.filter({ hasText: 'notes.txt' });
    await expect(notes).toContainText('A plain-text note');
    await expect(notes).toContainText(`${manifest['attachment.pdf'].attachments[0].size} B`);

    // Save a non-PDF attachment.
    const download = page.waitForEvent('download');
    await notes.getByRole('button', { name: 'Save' }).click();
    const file = await download;
    expect(file.suggestedFilename()).toBe('notes.txt');
    expect(readFileSync(await file.path(), 'utf8')).toBe('Hello from an attached text file.\n');

    // Open a PDF attachment in a new tab.
    await items.filter({ hasText: 'inner.pdf' }).getByRole('button', { name: 'Open' }).click();
    await expect(page.locator('.tab-item.active .tab-name')).toHaveText('inner.pdf');
    await expect(pageIn(page, 1).locator('.textLayer')).toContainText('Inner PDF');
    await page.getByRole('tab', { name: 'attachment.pdf' }).click();

    // Add one.
    await showPanel(page, 'Attachments');
    await panel(page).locator('#attach-file-input').setInputFiles(fixture('layers.pdf'));
    await expect.poll(() => lastLabel(page)).toBe('Attach layers.pdf');
    await expect(items).toHaveCount(3);
    await expect(page.locator('.tab-item.active .tab-dirty')).toBeVisible();

    // Remove one; undo brings it back.
    await panel(page).getByRole('button', { name: 'Remove notes.txt' }).click();
    await expect.poll(() => lastLabel(page)).toBe('Remove attachment notes.txt');
    await expect(items).toHaveCount(2);
    await expect(items.filter({ hasText: 'notes.txt' })).toHaveCount(0);
    await page.keyboard.press('Control+z');
    await expect(items).toHaveCount(3);

    // Saved file has them.
    const dl = page.waitForEvent('download');
    await page.keyboard.press('Control+s');
    const path = test.info().outputPath('att.pdf');
    await (await dl).saveAs(path);
    await page.setInputFiles('#file-input', path);
    await expect(page.getByRole('tab')).toHaveCount(3);
    await showPanel(page, 'Attachments');
    await expect(panel(page).locator('.attachment')).toHaveCount(3);
  });

  test('documents without attachments say so', async ({ page }) => {
    await openApp(page);
    await openFixture(page, 'multipage.pdf');
    await showPanel(page, 'Attachments');
    await expect(panel(page)).toContainText('No attachments');
  });
});

test.describe('layers', () => {
  test('default visibility respected; toggles re-render at once; reset', async ({ page }) => {
    await openApp(page);
    await openFixture(page, 'layers.pdf');
    await page.locator('.tool-row[data-tool="layers"]').click();
    const visible = panel(page).getByRole('checkbox', { name: 'Visible layer' });
    const hidden = panel(page).getByRole('checkbox', { name: 'Hidden layer' });
    await expect(visible).toBeChecked();
    await expect(hidden).not.toBeChecked();
    await expect.poll(() => colours(page)).toEqual({ green: true, red: false });

    await hidden.check();
    await expect.poll(() => colours(page)).toEqual({ green: true, red: true });
    await visible.uncheck();
    await expect.poll(() => colours(page)).toEqual({ green: false, red: true });
    // Not an edit: nothing to undo, nothing unsaved.
    expect(await page.evaluate(() => window.pdfEditor.app.activeTab.model.canUndo)).toBe(false);
    await expect(page.locator('.tab-item.active .tab-dirty')).toHaveCount(0);

    await panel(page).getByRole('button', { name: 'Hide all' }).click();
    await expect.poll(() => colours(page)).toEqual({ green: false, red: false });
    await panel(page).getByRole('button', { name: 'Show all' }).click();
    await expect.poll(() => colours(page)).toEqual({ green: true, red: true });
    await panel(page).getByRole('button', { name: 'Reset' }).click();
    await expect.poll(() => colours(page)).toEqual({ green: true, red: false });
    await expect(hidden).not.toBeChecked();
  });

  test('layer choices survive an edit to the document', async ({ page }) => {
    await openApp(page);
    await openFixture(page, 'layers.pdf');
    await showPanel(page, 'Layers');
    await panel(page).getByRole('checkbox', { name: 'Hidden layer' }).check();
    await expect.poll(() => colours(page)).toEqual({ green: true, red: true });
    await page.evaluate(() => window.pdfEditor.app.edit(window.pdfEditor.app.activeTab, 'setMetadata', { title: 'x' }, 'x'));
    await page.evaluate(() => window.pdfEditor.app.rotateCurrentPage(90));
    await expect(pageIn(page, 1)).toHaveAttribute('data-state', 'rendered');
    await expect.poll(() => colours(page)).toEqual({ green: true, red: true });
    await expect(panel(page).getByRole('checkbox', { name: 'Hidden layer' })).toBeChecked();
  });

  test('documents without layers say so', async ({ page }) => {
    await openApp(page);
    await openFixture(page, 'multipage.pdf');
    await showPanel(page, 'Layers');
    await expect(panel(page)).toContainText('This document has no optional content layers.');
  });
});

test('screenshots: info panels in light and dark', async ({ page }) => {
  for (const theme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: theme });
    await openApp(page);
    await openFixture(page, 'restricted.pdf');
    await showPanel(page, 'Document Properties');
    await panel(page).locator('.props-section').nth(0).evaluate((d) => { d.open = false; });
    await panel(page).locator('.props-section').nth(1).evaluate((d) => { d.open = false; });
    await page.waitForTimeout(300);
    await shot(page, `m7-properties-${theme}`);
    await openFixture(page, 'attachment.pdf');
    await showPanel(page, 'Attachments');
    await shot(page, `m7-attachments-${theme}`);
    await openFixture(page, 'layers.pdf');
    await showPanel(page, 'Layers');
    await panel(page).getByRole('checkbox', { name: 'Hidden layer' }).check();
    await page.waitForTimeout(400);
    await shot(page, `m7-layers-${theme}`);
    await page.evaluate(() => window.pdfEditor.storage.clearAll());
  }
});
