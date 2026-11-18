import { readFileSync } from 'node:fs';
import { PDFDocument } from 'pdf-lib';
import { test, expect, openApp, openFixture, pageIn, fixture, manifest, shot, reloadApp } from './helpers.mjs';

const dirtyDot = (page) => page.locator('.tab-item.active .tab-dirty');
const tabs = (page) => page.getByRole('tab');

async function describe(bytes) {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  return {
    rotations: doc.getPages().map((p) => p.getRotation().angle),
    meta: {
      title: doc.getTitle(),
      author: doc.getAuthor(),
      subject: doc.getSubject(),
      keywords: doc.getKeywords(),
      creator: doc.getCreator(),
      producer: doc.getProducer(),
      created: doc.getCreationDate()?.toISOString(),
      modified: doc.getModificationDate()?.toISOString(),
    },
  };
}

async function goTo(page, n) {
  await page.locator('.page-input').fill(String(n));
  await page.locator('.page-input').press('Enter');
}

async function isLandscape(page, n) {
  const box = await pageIn(page, n).boundingBox();
  return box.width > box.height;
}

async function menuItem(page, menu, name) {
  await page.getByRole('menuitem', { name: menu, exact: true }).click();
  return page.getByRole('menu', { name: menu }).getByRole('menuitem', { name: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*(Ctrl|⌘|$)`) });
}

async function rotate(page) {
  const before = await page.evaluate(() => window.pdfEditor.app.activeTab.model.history.index);
  await page.evaluate(() => window.pdfEditor.app.rotateCurrentPage(90));
  await expect.poll(() => page.evaluate(() => window.pdfEditor.app.activeTab.model.history.index)).toBe(before + 1);
}

test.describe('undo, redo and save', () => {
  test('rotate → undo → redo → save → reopen gives the right result', async ({ page }) => {
    await openApp(page);
    await openFixture(page, 'multipage.pdf');
    await goTo(page, 3);
    await expect(pageIn(page, 2)).toHaveAttribute('data-state', 'rendered');
    // Mark page 2's canvas: an edit to page 3 must not re-render page 2.
    await pageIn(page, 2).locator('.page-canvas').evaluate((c) => { c.dataset.marker = 'kept'; });
    expect(await isLandscape(page, 3)).toBe(false);

    await (await menuItem(page, 'Edit', 'Rotate current page 90°')).click();
    await expect.poll(() => isLandscape(page, 3)).toBe(true);
    await expect(pageIn(page, 3)).toHaveAttribute('data-state', 'rendered');
    await expect(dirtyDot(page)).toBeVisible();
    await expect(pageIn(page, 2).locator('.page-canvas')).toHaveAttribute('data-marker', 'kept');

    // The Edit menu names the step.
    await expect(await menuItem(page, 'Edit', 'Undo Rotate page 3')).toBeEnabled();
    await page.keyboard.press('Escape');

    await page.keyboard.press('Control+z');
    await expect.poll(() => isLandscape(page, 3)).toBe(false);
    await expect(dirtyDot(page)).toHaveCount(0);
    await expect(await menuItem(page, 'Edit', 'Redo Rotate page 3')).toBeEnabled();
    await page.keyboard.press('Escape');

    await page.keyboard.press('Control+Shift+Z');
    await expect.poll(() => isLandscape(page, 3)).toBe(true);
    await expect(dirtyDot(page)).toBeVisible();

    // Save: no file handle → download under the original name.
    const download = page.waitForEvent('download');
    await page.keyboard.press('Control+s');
    const file = await download;
    expect(file.suggestedFilename()).toBe('multipage.pdf');
    const savedPath = test.info().outputPath('saved.pdf');
    await file.saveAs(savedPath);
    await expect(dirtyDot(page)).toHaveCount(0);
    await expect(page.locator('.toast')).toContainText('“multipage.pdf” was downloaded.');

    const saved = await describe(readFileSync(savedPath));
    const original = await describe(readFileSync(fixture('multipage.pdf')));
    expect(saved.rotations).toEqual([0, 0, 90, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(saved.meta).toEqual(original.meta); // metadata intact

    // Undo still works after saving (and makes the document dirty again).
    await page.keyboard.press('Control+z');
    await expect.poll(() => isLandscape(page, 3)).toBe(false);
    await expect(dirtyDot(page)).toBeVisible();

    // Reopen the saved file: page 3 is rotated.
    await page.setInputFiles('#file-input', savedPath);
    await expect(tabs(page)).toHaveCount(2);
    await expect(pageIn(page, 1)).toHaveAttribute('data-state', 'rendered');
    await page.evaluate(() => window.pdfEditor.app.viewer.sizesLoaded);
    expect(await isLandscape(page, 3)).toBe(true);
    expect(await isLandscape(page, 2)).toBe(false);
  });

  test('Save writes back through the file handle; Save As suggests "-edited"', async ({ page }) => {
    await openApp(page);
    await openFixture(page, 'multipage.pdf');
    await page.evaluate(() => {
      const fakeHandle = (name, key) => ({
        kind: 'file',
        name,
        queryPermission: async () => 'granted',
        createWritable: async () => ({
          write: async (blob) => { window[key] = [...new Uint8Array(await blob.arrayBuffer())]; },
          close: async () => {},
        }),
      });
      window.pdfEditor.app.activeTab.model.fileHandle = fakeHandle('multipage.pdf', '__written');
      window.showSaveFilePicker = async (opts) => {
        window.__suggested = opts.suggestedName;
        return fakeHandle(opts.suggestedName, '__writtenAs');
      };
    });
    await rotate(page);
    let downloaded = false;
    page.on('download', () => { downloaded = true; });
    await page.keyboard.press('Control+s');
    await expect.poll(() => page.evaluate(() => !!window.__written)).toBe(true);
    await expect(dirtyDot(page)).toHaveCount(0);
    await expect(page.locator('.toast').last()).toContainText('Saved “multipage.pdf”.');
    const written = await describe(new Uint8Array(await page.evaluate(() => window.__written)));
    expect(written.rotations[0]).toBe(90);
    expect(downloaded).toBe(false);

    // Save As → picker with the "-edited" name; the tab takes the new name.
    await rotate(page);
    await page.keyboard.press('Control+Shift+S');
    await expect.poll(() => page.evaluate(() => window.__suggested)).toBe('multipage-edited.pdf');
    await expect.poll(() => page.evaluate(() => !!window.__writtenAs)).toBe(true);
    await expect(page.locator('.tab-item.active .tab-name')).toHaveText('multipage-edited.pdf');
    expect((await describe(new Uint8Array(await page.evaluate(() => window.__writtenAs)))).rotations[0]).toBe(180);

    // Without the File System Access API, Save As downloads "-edited".
    await page.evaluate(() => { delete window.showSaveFilePicker; window.pdfEditor.app.activeTab.rename('report.pdf'); });
    const download = page.waitForEvent('download');
    await page.keyboard.press('Control+Shift+S');
    expect((await download).suggestedFilename()).toBe('report-edited.pdf');
  });

  test('Undo History panel: every step, click to jump, redo branch, saved marker', async ({ page }) => {
    await openApp(page);
    await openFixture(page, 'multipage.pdf');
    for (const n of [1, 2, 3]) {
      await goTo(page, n);
      await rotate(page);
    }
    await page.locator('.tool-row[data-tool="undo-history"]').click();
    const list = page.getByRole('listbox', { name: 'Undo History' });
    const items = list.getByRole('option');
    await expect(items.locator('.history-label')).toHaveText(['Opened multipage.pdf', 'Rotate page 1', 'Rotate page 2', 'Rotate page 3']);
    await expect(items.nth(3)).toHaveAttribute('aria-selected', 'true');

    await items.nth(0).click();
    await expect(items.nth(0)).toHaveAttribute('aria-selected', 'true');
    await expect(dirtyDot(page)).toHaveCount(0);
    await expect(items.nth(1)).toHaveClass(/future/);
    expect(await isLandscape(page, 1)).toBe(false);

    await items.nth(2).click();
    await expect(items.nth(2)).toHaveAttribute('aria-selected', 'true');
    await expect.poll(() => isLandscape(page, 2)).toBe(true);
    expect(await isLandscape(page, 1)).toBe(true);
    expect(await isLandscape(page, 3)).toBe(false);

    // A new step drops the redo branch.
    await goTo(page, 5);
    await rotate(page);
    await expect(items.locator('.history-label')).toHaveText(['Opened multipage.pdf', 'Rotate page 1', 'Rotate page 2', 'Rotate page 5']);

    // Saved marker follows the saved state.
    await expect(items.locator('.history-saved')).toHaveCount(1);
    await expect(items.nth(0).locator('.history-saved')).toHaveText('Saved');
    const download = page.waitForEvent('download');
    await page.keyboard.press('Control+s');
    await download;
    await expect(items.nth(3).locator('.history-saved')).toBeVisible();

    // Keyboard: ↑ then Enter jumps to that step.
    await items.nth(3).focus();
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('Enter');
    await expect(items.nth(2)).toHaveAttribute('aria-selected', 'true');
    await expect(dirtyDot(page)).toBeVisible();
  });

  test('Ctrl+Z inside a text field edits the text, not the document', async ({ page }) => {
    await openApp(page);
    await openFixture(page, 'multipage.pdf');
    await rotate(page);
    await page.keyboard.press('Control+f');
    await page.keyboard.type('abc');
    await page.keyboard.press('Control+z');
    expect(await page.evaluate(() => window.pdfEditor.app.activeTab.model.canUndo)).toBe(true);
    await expect(dirtyDot(page)).toBeVisible();
  });
});

test.describe('autosave and recovery', () => {
  test('unsaved changes are recovered after a reload; discarding works', async ({ page }) => {
    page.on('dialog', (d) => d.accept());
    await openApp(page);
    await openFixture(page, 'multipage.pdf');
    await goTo(page, 3);
    await rotate(page);
    await openFixture(page, 'outline.pdf');
    await rotate(page);
    await page.evaluate(() => window.pdfEditor.app.autosave.runNow());

    await reloadApp(page);
    const recovery = page.locator('.recovery');
    await expect(recovery.getByRole('heading')).toHaveText('Recover unsaved changes');
    await expect(recovery.locator('.recovery-item')).toHaveCount(2);
    await expect(recovery.locator('.recovery-item').filter({ hasText: 'multipage.pdf' })).toContainText('1 change ·');

    await recovery.locator('.recovery-item').filter({ hasText: 'multipage.pdf' }).getByRole('button', { name: 'Recover' }).click();
    await expect(page.locator('.tab-item.active .tab-name')).toHaveText('multipage.pdf');
    await expect(dirtyDot(page)).toBeVisible();
    await expect(pageIn(page, 1)).toHaveAttribute('data-state', 'rendered');
    await page.evaluate(() => window.pdfEditor.app.viewer.sizesLoaded);
    expect(await isLandscape(page, 3)).toBe(true);
    // Its history starts at the recovered state.
    expect(await page.evaluate(() => window.pdfEditor.app.activeTab.model.history.current.label)).toBe('Recovered multipage.pdf');

    // Saving clears its autosave: after a reload only the other one is offered.
    const download = page.waitForEvent('download');
    await page.keyboard.press('Control+s');
    await download;
    // The download starts before the app has finished clearing the autosave.
    await expect.poll(() => page.evaluate(async () => (await window.pdfEditor.app.listRecoverable()).length)).toBe(1);
    await reloadApp(page);
    await expect(recovery.locator('.recovery-item')).toHaveCount(1);
    await expect(recovery.locator('.recovery-item')).toContainText('outline.pdf');

    await recovery.getByRole('button', { name: 'Discard' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Discard' }).click();
    await expect(recovery).toBeHidden();
    await reloadApp(page);
    await expect(recovery).toBeHidden();
  });
});

test.describe('unsaved-change guards', () => {
  test('closing a dirty tab: Cancel, Save, Don’t save', async ({ page }) => {
    await openApp(page);
    await openFixture(page, 'multipage.pdf');
    await openFixture(page, 'outline.pdf');
    await rotate(page);
    const dialog = page.getByRole('dialog', { name: 'Save changes to “outline.pdf”?' });

    await page.keyboard.press('Control+w');
    await expect(dialog.getByRole('button')).toHaveText(['Don’t save', 'Cancel', 'Save']);
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(tabs(page)).toHaveCount(2);

    const download = page.waitForEvent('download');
    await page.keyboard.press('Control+w');
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    expect((await download).suggestedFilename()).toBe('outline.pdf');
    await expect(tabs(page)).toHaveCount(1);

    await rotate(page); // multipage.pdf
    await page.evaluate(() => window.pdfEditor.app.autosave.runNow());
    await page.locator('.tab-item').filter({ hasText: 'multipage.pdf' }).locator('.tab-close').click();
    await page.getByRole('dialog').getByRole('button', { name: 'Don’t save' }).click();
    await expect(tabs(page)).toHaveCount(0);
    // Don't save also drops its autosave: nothing to recover.
    await expect(page.locator('.recovery')).toBeHidden();

    // Reopening a closed tab brings its (unsaved) state back.
    await page.keyboard.press('Control+Shift+T');
    await expect(dirtyDot(page)).toBeVisible();
  });

  test('leaving the page with unsaved changes asks first', async ({ page }) => {
    await openApp(page);
    await openFixture(page, 'multipage.pdf');
    // Clean document: no prompt.
    let asked = false;
    page.on('dialog', async (d) => {
      if (d.type() === 'beforeunload') asked = true;
      await d.dismiss();
    });
    await rotate(page);
    await page.close({ runBeforeUnload: true });
    await expect.poll(() => asked).toBe(true);
  });

  test('a clean document leaves without asking', async ({ page }) => {
    await openApp(page);
    await openFixture(page, 'multipage.pdf');
    let asked = false;
    page.on('dialog', async (d) => {
      asked = true;
      await d.dismiss();
    });
    await page.close({ runBeforeUnload: true });
    await new Promise((r) => setTimeout(r, 300));
    expect(asked).toBe(false);
  });
});

test.describe('read-only documents', () => {
  test.skip(!manifest['encrypted.pdf'], 'no encrypted fixture');

  test('password-protected PDFs are read-only, and say why', async ({ page }) => {
    await openApp(page);
    await openFixture(page, 'encrypted.pdf', { waitForRender: false });
    await page.getByRole('dialog').getByLabel('Password').fill(manifest['encrypted.pdf'].password);
    await page.getByRole('dialog').getByRole('button', { name: 'Open' }).click();
    await expect(pageIn(page, 1)).toHaveAttribute('data-state', 'rendered');
    await expect(await menuItem(page, 'Edit', 'Rotate current page 90°')).toHaveAttribute('aria-disabled', 'true');
    await page.keyboard.press('Escape');
    await page.evaluate(() => window.pdfEditor.app.rotateCurrentPage(90));
    await expect(page.locator('.toast')).toContainText('Protected (encrypted) PDFs can’t be edited until you remove the protection');
    await expect(dirtyDot(page)).toHaveCount(0);
  });
});

test('screenshots: editing UI in light and dark', async ({ page }) => {
  page.on('dialog', (d) => d.accept());
  for (const theme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: theme });
    await openApp(page);
    await openFixture(page, 'multipage.pdf');
    for (const n of [1, 2]) {
      await goTo(page, n);
      await rotate(page);
    }
    await page.locator('.rail').getByRole('button', { name: 'Undo History' }).click();
    await page.getByRole('option').nth(1).click();
    await page.waitForTimeout(300);
    await shot(page, `m4-history-${theme}`);
    await page.getByRole('menuitem', { name: 'Edit', exact: true }).click();
    await shot(page, `m4-edit-menu-${theme}`);
    await page.keyboard.press('Escape');
    await page.keyboard.press('Control+w');
    await shot(page, `m4-unsaved-dialog-${theme}`);
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
    await page.evaluate(() => window.pdfEditor.app.autosave.runNow());
    await reloadApp(page);
    await expect(page.locator('.recovery')).toBeVisible();
    await shot(page, `m4-recovery-${theme}`);
    await page.evaluate(() => window.pdfEditor.storage.clearAll());
  }
});
