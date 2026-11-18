// M12 — Accessibility Checker.
import { readFileSync } from 'node:fs';
import { PDFDocument, PDFName } from 'pdf-lib';
import { test, expect, openApp, openFixture, shot } from './helpers.mjs';

const dialog = (page) => page.getByRole('dialog', { name: 'Accessibility check' });
const check = (page, id) => dialog(page).locator(`.a11y-check[data-check="${id}"]`);
const run = (page) => page.evaluate(() => { window.pdfEditor.registry.getTool('accessibility-check').run({ app: window.pdfEditor.app }); });
const lastLabel = (page) => page.evaluate(() => window.pdfEditor.app.activeTab.model.history.current.label);
async function stepDone(page, label) {
  await expect.poll(() => lastLabel(page)).toBe(label);
  await page.waitForFunction(() => !window.pdfEditor.app.activeTab.model.busy);
}

test.describe('accessibility checker', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1400, height: 900 });
    await openApp(page);
  });

  test('finds the problems of a tagged document, fixes language and field names, links to pages', async ({ page }) => {
    await openFixture(page, 'a11y.pdf');
    await run(page);
    await expect(dialog(page).locator('.a11y-summary')).toHaveText('1 passed · 5 to fix · 1 to review');
    await expect(check(page, 'tagged')).toHaveClass(/status-pass/);
    await expect(check(page, 'title')).toHaveClass(/status-fail/);
    await expect(check(page, 'lang')).toHaveClass(/status-fail/);
    await expect(check(page, 'alt')).toContainText('1 figure has no alternative text');
    await expect(check(page, 'alt').locator('.a11y-item')).toHaveText(['Figure on page 1Go to page 1']);
    await expect(check(page, 'fields')).toContainText('Field “email” on page 1');
    await expect(check(page, 'fields')).not.toContainText('full_name');
    await expect(check(page, 'bookmarks')).toContainText('This 22-page document has no bookmarks');
    await expect(check(page, 'text')).toContainText('1 page has no text');
    await shot(page, 'm12-a11y-light');

    // Fix: language.
    await check(page, 'lang').getByRole('combobox', { name: /Language tag/ }).fill('english');
    await check(page, 'lang').getByRole('button', { name: 'Set language' }).click();
    await expect(check(page, 'lang').getByRole('alert')).toContainText('Use a language tag');
    await check(page, 'lang').getByRole('combobox', { name: /Language tag/ }).fill('en-GB');
    await check(page, 'lang').getByRole('button', { name: 'Set language' }).click();
    await stepDone(page, 'Set language to en-GB');
    await expect(check(page, 'lang')).toHaveClass(/status-pass/);
    await expect(check(page, 'lang')).toContainText('Language: en-GB');

    // Fix: give the field an accessible name.
    await check(page, 'fields').getByRole('button', { name: 'Name it' }).click();
    const props = page.getByRole('dialog', { name: 'Text field properties' });
    await props.getByLabel('Accessible name').fill('Email address');
    await props.getByRole('button', { name: 'Apply' }).click();
    await stepDone(page, 'Edit field email');
    await expect(check(page, 'fields')).toHaveClass(/status-pass/);

    // Page links close the report and go to the page.
    await check(page, 'text').getByRole('button', { name: 'Go to page 3' }).click();
    await expect(dialog(page)).toBeHidden();
    await expect.poll(() => page.evaluate(() => window.pdfEditor.app.viewer.current)).toBe(2);

    // The fixes are in the saved file.
    const download = page.waitForEvent('download');
    await page.keyboard.press('Control+s');
    const path = test.info().outputPath('a11y-fixed.pdf');
    await (await download).saveAs(path);
    const doc = await PDFDocument.load(readFileSync(path));
    expect(doc.catalog.lookup(PDFName.of('Lang')).decodeText()).toBe('en-GB');
    expect(doc.getForm().getField('email').acroField.dict.lookup(PDFName.of('TU')).decodeText()).toBe('Email address');
  });

  test('untagged document: honest about what can’t be fixed; title fixes', async ({ page }) => {
    await openFixture(page, 'multipage.pdf');
    await run(page);
    await expect(check(page, 'tagged')).toHaveClass(/status-fail/);
    await expect(check(page, 'tagged')).toContainText('PDF Editor can’t add tags');
    await expect(check(page, 'title')).toContainText('Title: “Multipage sample”');
    await expect(check(page, 'bookmarks')).toHaveClass(/status-na/);
    await expect(check(page, 'text')).toHaveClass(/status-pass/);
    await check(page, 'displayTitle').getByRole('button', { name: 'Show the title' }).click();
    await stepDone(page, 'Show the title in the window');
    await expect(check(page, 'displayTitle')).toHaveCount(0);
    await dialog(page).getByRole('button', { name: 'Close' }).click();
    await expect(dialog(page)).toBeHidden();

    await openFixture(page, 'a11y.pdf');
    await run(page);
    await check(page, 'title').getByRole('button', { name: 'Add a title' }).click();
    await expect(dialog(page)).toBeHidden();
    await expect(page.locator('#side-panel input[name="title"]')).toBeFocused();
  });

  test('screenshot: dark', async ({ page }) => {
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
    await openFixture(page, 'a11y.pdf');
    await run(page);
    await expect(dialog(page).locator('.a11y-summary')).toContainText('passed');
    await shot(page, 'm12-a11y-dark');
  });
});
