// M10 — redaction, sanitize, password protection (qpdf WASM) and print.
import { readFileSync } from 'node:fs';
import * as PDFLib from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { test, expect, openApp, openFixture, pageIn, shot, manifest } from './helpers.mjs';

const panel = (page) => page.locator('#side-panel');
const lastLabel = (page) => page.evaluate(() => window.pdfEditor.app.activeTab.model.history.current.label);
async function stepDone(page, label) {
  await expect.poll(() => lastLabel(page), { timeout: 15_000 }).toBe(label);
  await page.waitForFunction(() => !window.pdfEditor.app.activeTab.model.busy);
}
const run = (page, id) => page.evaluate((id) => { window.pdfEditor.registry.getTool(id).run({ app: window.pdfEditor.app }); }, id);
const pageText = (page, n) => page.evaluate(async (n) => {
  const proxy = await window.pdfEditor.app.activeTab.pdf.getPage(n);
  return (await proxy.getTextContent()).items.map((i) => i.str).join(' ');
}, n);
const hex = (s) => Buffer.from(s, 'latin1').toString('hex').toUpperCase();

async function save(page, name) {
  const download = page.waitForEvent('download');
  await page.keyboard.press('Control+s');
  const path = test.info().outputPath(name);
  await (await download).saveAs(path);
  return path;
}

/** Every stream in a file, decoded (what a forensic look at the file would find). */
async function allStreams(bytes) {
  const doc = await PDFLib.PDFDocument.load(bytes, { updateMetadata: false });
  let out = '';
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (obj instanceof PDFLib.PDFRawStream) {
      try {
        out += Buffer.from(PDFLib.decodePDFRawStream(obj).decode()).toString('latin1');
      } catch { /* images */ }
    }
  }
  return out;
}

async function drag(page, n, from, to) {
  const pb = await pageIn(page, n).boundingBox();
  await page.mouse.move(pb.x + from[0], pb.y + from[1]);
  await page.mouse.down();
  await page.mouse.move(pb.x + to[0], pb.y + to[1], { steps: 6 });
  await page.mouse.up();
}

test.describe('protect, redact, print', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1400, height: 900 });
    await openApp(page);
  });

  test('redaction: mark by area and by search, review, apply; the text is gone for good', async ({ page }) => {
    await openFixture(page, 'multipage.pdf');
    await run(page, 'redact');
    const bar = page.getByRole('toolbar', { name: 'Redaction tools' });
    await expect(bar).toBeVisible();
    await expect(bar.getByRole('status')).toHaveText('No marks yet');

    // Mark all matches of a search.
    await bar.getByRole('searchbox', { name: 'Text to redact' }).fill('quokka');
    await bar.getByRole('button', { name: 'Mark all matches' }).click();
    await stepDone(page, 'Mark 4 matches for redaction');
    await expect(bar.getByRole('status')).toHaveText('4 marks on 3 pages');

    // Mark an area on page 1, then review: delete it again.
    await drag(page, 1, [60, 60], [400, 160]);
    await stepDone(page, 'Mark for redaction');
    await expect(bar.getByRole('status')).toHaveText('5 marks on 4 pages');
    await expect(page.locator('.annot-selection')).toBeVisible();
    await shot(page, 'm10-redact-light');
    await page.keyboard.press('Delete');
    await stepDone(page, 'Delete Redaction mark');
    await expect(bar.getByRole('status')).toHaveText('4 marks on 3 pages');
    // Marks are listed with the comments too.
    await page.evaluate(() => window.pdfEditor.app.showPanel('comments'));
    await panel(page).getByRole('combobox', { name: 'Filter by type' }).selectOption({ label: 'Redaction mark' });
    await expect(panel(page).locator('.comment-thread')).toHaveCount(4);

    expect(await pageText(page, 2)).toContain('quokka');
    await bar.getByRole('button', { name: 'Apply redactions…' }).click();
    const dialog = page.getByRole('dialog', { name: 'Apply redactions?' });
    await expect(dialog).toContainText('4 areas on 3 pages (2, 5, 9)');
    await expect(dialog).toContainText('can no longer be selected');
    await dialog.getByRole('button', { name: 'Apply redactions' }).click();
    await stepDone(page, 'Apply 4 redactions');
    for (const n of [2, 5, 9]) expect((await pageText(page, n)).trim(), `page ${n}`).toBe('');
    expect(await pageText(page, 1)).toContain('page-marker-01'); // not redacted
    expect(await pageText(page, 3)).toContain('page-marker-03');
    await expect(bar.getByRole('status')).toHaveText('No marks yet');

    // The black box is burned into page 2's pixels.
    await page.evaluate(() => window.pdfEditor.app.viewer.goToPage(2));
    await expect(pageIn(page, 2)).toHaveAttribute('data-state', 'rendered');
    const dark = await page.evaluate(() => {
      const c = document.querySelector('.viewer-host:not([hidden]) .page[data-page-number="2"] .page-canvas');
      const { data } = c.getContext('2d').getImageData(0, 0, c.width, c.height);
      let n = 0;
      for (let i = 0; i < data.length; i += 4) if (data[i] < 20 && data[i + 1] < 20 && data[i + 2] < 20) n++;
      return n;
    });
    expect(dark).toBeGreaterThan(200);

    // Saved file: no trace of the word in any stream, on any redacted page.
    const path = await save(page, 'redacted.pdf');
    const bytes = readFileSync(path);
    const streams = await allStreams(bytes);
    expect(streams.toLowerCase()).not.toContain('quokka');
    expect(streams).not.toContain(hex('quokka'));
    expect(streams).not.toContain(hex('A quokka is a small marsupial.'));
    expect(streams).toContain(hex('page-marker-01'));

    // One undo step brings everything back.
    await page.keyboard.press('Control+z');
    await stepDone(page, 'Delete Redaction mark');
    expect(await pageText(page, 2)).toContain('quokka');
  });

  test('sanitize removes exactly the selected items', async ({ page }) => {
    await openFixture(page, 'sanitize.pdf');
    await run(page, 'sanitize');
    const dialog = page.getByRole('dialog', { name: 'Sanitize document' });
    const row = (key) => dialog.locator(`.sanitize-row[data-key="${key}"]`);
    await expect(row('javascript')).toContainText('4 found');
    await expect(row('attachments')).toContainText('1 found');
    await expect(row('hiddenLayers')).toContainText('1 found');
    await expect(row('comments')).toContainText('1 found');
    for (const key of ['metadata', 'javascript', 'attachments', 'hiddenLayers']) await expect(row(key).getByRole('checkbox')).toBeChecked();
    await expect(row('comments').getByRole('checkbox')).not.toBeChecked();
    await shot(page, 'm10-sanitize-light');
    await dialog.getByRole('button', { name: 'Remove selected' }).click();
    await stepDone(page, 'Sanitize document');

    const path = await save(page, 'sanitized.pdf');
    const bytes = readFileSync(path);
    const task = pdfjs.getDocument({ data: new Uint8Array(bytes), verbosity: 0 });
    const pdf = await task.promise;
    const meta = await pdf.getMetadata();
    expect(meta.info.Title).toBeUndefined();
    expect(meta.info.Author).toBeUndefined();
    expect(await pdf.getAttachments()).toBeFalsy();
    expect(await pdf.getJSActions()).toBeFalsy();
    const p1 = await pdf.getPage(1);
    const text = (await p1.getTextContent()).items.map((i) => i.str).join(' ');
    expect(text).toContain(manifest['sanitize.pdf'].shownText);
    expect(text).not.toContain(manifest['sanitize.pdf'].hiddenText);
    const annots = await p1.getAnnotations();
    expect(annots.map((a) => a.subtype).sort()).toEqual(['Link', 'Text']); // the web link and the (unchecked) comment stay
    await task.destroy();
    const streams = await allStreams(bytes);
    expect(streams).not.toContain('secret notes');
    expect(streams).not.toContain(hex(manifest['sanitize.pdf'].hiddenText));
    expect(Buffer.from(bytes).toString('latin1')).not.toContain('app.alert');

    // The Layers panel now has only the visible layer.
    await page.evaluate(() => window.pdfEditor.app.showPanel('layers'));
    await expect(panel(page).locator('.layer-row, [role="treeitem"], li').filter({ hasText: 'Draft notes' })).toHaveCount(0);
    await page.keyboard.press('Control+z');
    await stepDone(page, 'Opened sanitize.pdf');
  });

  test('password protection: AES-256 protected copy, then remove protection with the owner password', async ({ page }) => {
    await openFixture(page, 'multipage.pdf');
    await run(page, 'protect-password');
    let dialog = page.getByRole('dialog', { name: 'Password protection' });
    await dialog.getByLabel('Open password').fill('open-sesame');
    await dialog.getByLabel('Confirm password').first().fill('open-sesame');
    await dialog.getByLabel('Restrict printing, copying and editing').check();
    await dialog.getByLabel('Owner password').fill('boss-pass');
    await dialog.getByLabel('Confirm password').nth(1).fill('boss-pss');
    await dialog.getByRole('button', { name: 'Save protected copy' }).click();
    await expect(dialog.getByRole('alert')).toHaveText('The passwords don’t match.');
    await dialog.getByLabel('Confirm password').nth(1).fill('boss-pass');
    await dialog.getByLabel('Printing', { exact: true }).uncheck();
    await shot(page, 'm10-protect-light');
    const download = page.waitForEvent('download');
    await dialog.getByRole('button', { name: 'Save protected copy' }).click();
    const file = await download;
    expect(file.suggestedFilename()).toBe('multipage-protected.pdf');
    const path = test.info().outputPath('multipage-protected.pdf');
    await file.saveAs(path);
    const bytes = new Uint8Array(readFileSync(path));
    expect(Buffer.from(bytes).toString('latin1')).toMatch(/\/V\s*5/); // AES-256 (PDF 2.0 / R6)

    // pdf.js: needs the password; printing isn't allowed.
    await expect(pdfjs.getDocument({ data: bytes.slice(), verbosity: 0 }).promise).rejects.toMatchObject({ name: 'PasswordException' });
    const task = pdfjs.getDocument({ data: bytes.slice(), password: 'open-sesame', verbosity: 0 });
    const pdf = await task.promise;
    expect(pdf.numPages).toBe(12);
    const perms = await pdf.getPermissions();
    const allowed = perms instanceof Set ? perms : new Set(perms ?? []);
    expect(allowed.has(pdfjs.PermissionFlag.PRINT)).toBe(false);
    expect(allowed.has(pdfjs.PermissionFlag.COPY)).toBe(true);
    await task.destroy();

    // Open the protected copy (read-only), then remove its protection.
    await page.evaluate(() => document.querySelectorAll('.viewer').forEach((v) => v.classList.add('stale-viewer')));
    await page.setInputFiles('#file-input', path);
    await page.getByRole('dialog', { name: 'Password required' }).getByLabel('Password').fill('open-sesame');
    await page.getByRole('dialog', { name: 'Password required' }).getByRole('button', { name: 'Open' }).click();
    await expect(pageIn(page, 1)).toHaveAttribute('data-state', 'rendered');
    await expect.poll(() => page.evaluate(() => window.pdfEditor.app.activeTab.model.readOnly)).toBe('encrypted');
    await run(page, 'protect-password');
    dialog = page.getByRole('dialog', { name: 'Remove password protection' });
    await expect(dialog).toContainText('AES-256');
    await dialog.getByLabel('Owner password').fill('wrong');
    await dialog.getByRole('button', { name: 'Remove protection' }).click();
    await expect(page.locator('.toast').filter({ hasText: 'isn’t the owner password' })).toBeVisible();
    expect(await page.evaluate(() => window.pdfEditor.app.activeTab.model.readOnly)).toBe('encrypted');
    await run(page, 'protect-password');
    await dialog.getByLabel('Owner password').fill('boss-pass');
    await dialog.getByRole('button', { name: 'Remove protection' }).click();
    await stepDone(page, 'Remove password protection');
    expect(await page.evaluate(() => window.pdfEditor.app.activeTab.model.readOnly)).toBe(null);
    // Editable now; undo makes it protected (read-only) again.
    await page.evaluate(() => window.pdfEditor.app.rotateCurrentPage(90));
    await stepDone(page, 'Rotate page 1');
    await page.keyboard.press('Control+z');
    await page.keyboard.press('Control+z');
    await stepDone(page, 'Opened multipage-protected.pdf');
    expect(await page.evaluate(() => window.pdfEditor.app.activeTab.model.readOnly)).toBe('encrypted');
    await page.keyboard.press('Control+Shift+Z');
    await stepDone(page, 'Remove password protection');
    const saved = readFileSync(await save(page, 'unprotected.pdf'));
    const plain = await pdfjs.getDocument({ data: new Uint8Array(saved), verbosity: 0 }).promise;
    expect(plain.numPages).toBe(12);
  });

  test('print renders the chosen pages at the chosen dpi; respects "no printing"', async ({ page }) => {
    await openFixture(page, 'mixed-sizes.pdf');
    await page.evaluate(() => {
      window.__printed = null;
      window.pdfEditor.app.printer.printFrame = (iframe) => {
        const imgs = [...iframe.contentDocument.images];
        window.__printed = imgs.map((i) => ({ w: i.naturalWidth, h: i.naturalHeight, cssW: i.style.width || getComputedStyle(i).width }));
      };
    });
    await page.keyboard.press('Control+p');
    const dialog = page.getByRole('dialog', { name: 'Print' });
    await dialog.getByLabel('Pages:').check();
    await dialog.locator('input[name="range"]').fill('9');
    await dialog.getByRole('button', { name: 'Print' }).click();
    await expect(dialog.getByRole('alert')).toContainText('“9” isn’t a valid page');
    await dialog.locator('input[name="range"]').fill('1-2');
    await dialog.getByLabel('High (300 dpi)').check();
    await shot(page, 'm10-print-light');
    await dialog.getByRole('button', { name: 'Print' }).click();
    await expect.poll(() => page.evaluate(() => window.__printed), { timeout: 20_000 }).toBeTruthy();
    const printed = await page.evaluate(() => window.__printed);
    expect(printed).toHaveLength(2);
    // mixed-sizes page 1 is A4 portrait: 595.28 pt = 8.27 in × 300 dpi.
    expect(Math.abs(printed[0].w - 2480)).toBeLessThanOrEqual(2);

    await openFixture(page, 'restricted.pdf');
    await page.keyboard.press('Control+p');
    await expect(page.locator('.toast').filter({ hasText: 'doesn’t allow printing' })).toBeVisible();
  });

  test('screenshots: dark theme', async ({ page }) => {
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
    await openFixture(page, 'multipage.pdf');
    await run(page, 'redact');
    await page.getByRole('toolbar', { name: 'Redaction tools' }).getByRole('searchbox').fill('quokka');
    await page.getByRole('toolbar', { name: 'Redaction tools' }).getByRole('button', { name: 'Mark all matches' }).click();
    await stepDone(page, 'Mark 4 matches for redaction');
    await page.evaluate(() => window.pdfEditor.app.viewer.goToPage(9));
    await expect(pageIn(page, 9)).toHaveAttribute('data-state', 'rendered');
    await shot(page, 'm10-redact-dark');
    await page.getByRole('toolbar', { name: 'Redaction tools' }).getByRole('button', { name: 'Apply redactions…' }).click();
    await expect(page.getByRole('dialog', { name: 'Apply redactions?' })).toBeVisible();
    await shot(page, 'm10-redact-confirm-dark');
    await page.keyboard.press('Escape');
    await openFixture(page, 'sanitize.pdf');
    await run(page, 'sanitize');
    await expect(page.getByRole('dialog', { name: 'Sanitize document' })).toBeVisible();
    await shot(page, 'm10-sanitize-dark');
    await page.keyboard.press('Escape');
    await run(page, 'protect-password');
    await page.getByRole('dialog', { name: 'Password protection' }).getByLabel('Restrict printing, copying and editing').check();
    await shot(page, 'm10-protect-dark');
    await page.keyboard.press('Escape');
  });
});
