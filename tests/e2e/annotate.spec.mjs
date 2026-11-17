// M8 — comments and annotations.
import { readFileSync } from 'node:fs';
import { PDFDocument, PDFName } from 'pdf-lib';
import { test, expect, openApp, openFixture, pageIn, shot } from './helpers.mjs';

const panel = (page) => page.locator('#side-panel');
const bar = (page) => page.getByRole('toolbar', { name: 'Editing tools', includeHidden: true });
const lastLabel = (page) => page.evaluate(() => window.pdfEditor.app.activeTab.model.history.current.label);
/** Wait for a named step and for the view to have reloaded the changed document. */
async function stepDone(page, label) {
  await expect.poll(() => lastLabel(page)).toBe(label);
  await page.waitForFunction(() => !window.pdfEditor.app.activeTab.model.busy);
}
const threads = (page) => panel(page).locator('.comment-thread');

/** Annotations pdf.js reads from page n of the active tab. */
const annotationsOf = (page, n = 1) => page.evaluate(async (n) => {
  const tab = window.pdfEditor.app.activeTab;
  const proxy = await tab.pdf.getPage(n);
  return (await proxy.getAnnotations()).map((a) => ({
    id: a.id,
    subtype: a.subtype,
    rect: [...a.rect],
    contents: a.contentsObj?.str ?? '',
    author: a.titleObj?.str ?? '',
    color: a.color ? [...a.color] : null,
    opacity: a.opacity,
    hasAppearance: a.hasAppearance,
    inReplyTo: a.inReplyTo ?? null,
    state: a.state ?? null,
    lineEndings: a.lineEndings ?? null,
    fontColor: a.defaultAppearanceData?.fontColor ? [...a.defaultAppearanceData.fontColor] : null,
  }));
}, n);

async function tool(page, name) {
  await bar(page).getByRole('button', { name, exact: true }).click();
}

/** Drag across the text-layer span containing `text` (from 0 to `upTo` of its width). */
async function selectText(page, text, upTo = 0.5) {
  const span = pageIn(page, 1).locator('.textLayer span').filter({ hasText: text }).first();
  const b = await span.boundingBox();
  await page.mouse.move(b.x + 1, b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width * upTo, b.y + b.height / 2, { steps: 6 });
  await page.mouse.up();
}

/** Drag on page 1 between two points given in page-relative CSS px. */
async function drag(page, from, to, { via } = {}) {
  const pb = await pageIn(page, 1).boundingBox();
  await page.mouse.move(pb.x + from[0], pb.y + from[1]);
  await page.mouse.down();
  if (via) for (const p of via) await page.mouse.move(pb.x + p[0], pb.y + p[1], { steps: 3 });
  await page.mouse.move(pb.x + to[0], pb.y + to[1], { steps: 6 });
  await page.mouse.up();
}

async function clickOnPage(page, at) {
  const pb = await pageIn(page, 1).boundingBox();
  await page.mouse.click(pb.x + at[0], pb.y + at[1]);
}

async function save(page, name) {
  const download = page.waitForEvent('download');
  await page.keyboard.press('Control+s');
  const path = test.info().outputPath(name);
  await (await download).saveAs(path);
  return path;
}

test.describe('comments and annotations', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1400, height: 900 });
    await openApp(page);
    await page.evaluate(() => window.pdfEditor.app.setSetting?.('author', 'Ada Reviewer'));
  });

  test('create every type, save, reopen in a new tab and read them back with pdf.js', async ({ page }) => {
    await page.evaluate(async () => {
      const { setSetting } = await import('@app/core/settings.js');
      setSetting('author', 'Ada Reviewer');
    });
    await openFixture(page, 'multipage.pdf');
    await page.evaluate(() => window.pdfEditor.registry.getTool('highlight').run({ app: window.pdfEditor.app }));
    await expect(bar(page)).toBeVisible();
    await expect(bar(page).getByRole('button', { name: 'Highlight text' })).toHaveAttribute('aria-pressed', 'true');

    // Text markup from a text selection.
    await selectText(page, /quick brown/, 0.3);
    await stepDone(page, 'Add Highlight');
    await tool(page, 'Underline text');
    await selectText(page, /Unique marker/, 0.9);
    await stepDone(page, 'Add Underline');
    await tool(page, 'Strike out text');
    await selectText(page, /Page 1 of 12/, 0.9);
    await stepDone(page, 'Add Strike-out');

    // Shapes and freehand ink.
    await tool(page, 'Rectangle');
    await drag(page, [80, 380], [220, 470]);
    await stepDone(page, 'Add Rectangle');
    await tool(page, 'Ellipse');
    await drag(page, [260, 380], [400, 470]);
    await stepDone(page, 'Add Ellipse');
    await tool(page, 'Line');
    await drag(page, [80, 500], [220, 520]);
    await stepDone(page, 'Add Line');
    await tool(page, 'Arrow');
    await drag(page, [260, 500], [400, 560]);
    await stepDone(page, 'Add Line');
    await tool(page, 'Freehand drawing');
    await drag(page, [440, 380], [600, 470], { via: [[480, 470], [520, 380], [560, 470]] });
    await stepDone(page, 'Add Drawing');

    // Text box: drawn like a rectangle, then typed into.
    await tool(page, 'Text box');
    await drag(page, [80, 590], [320, 620]);
    await page.getByRole('textbox', { name: 'Text box text' }).fill('Hello text box');
    await page.keyboard.press('Control+Enter');
    await stepDone(page, 'Add Text box');

    // Sticky note: placed with a click, then its text typed in the Comments panel.
    await tool(page, 'Sticky note');
    await clickOnPage(page, [500, 600]);
    await stepDone(page, 'Add Note');
    const editor = panel(page).getByRole('textbox', { name: 'Comment text' });
    await expect(editor).toBeFocused();
    await editor.fill('A sticky note');
    await panel(page).getByRole('button', { name: 'Save' }).click();
    await stepDone(page, 'Edit comment');
    await expect(threads(page)).toHaveCount(10);

    // Everything is real annotations with appearances, readable by pdf.js.
    const live = await annotationsOf(page);
    const count = (list, s) => list.filter((a) => a.subtype === s).length;
    const expected = { Highlight: 1, Underline: 1, StrikeOut: 1, Square: 1, Circle: 1, Line: 2, Ink: 1, FreeText: 1, Text: 1 };
    for (const [s, n] of Object.entries(expected)) expect(count(live, s), s).toBe(n);

    await shot(page, 'm8-annotations-light');
    const path = await save(page, 'annotated.pdf');

    // pdf-lib: every annotation has an /AP /N appearance stream.
    const doc = await PDFDocument.load(readFileSync(path));
    const annots = doc.getPage(0).node.Annots().asArray().map((r) => doc.context.lookup(r));
    expect(annots).toHaveLength(10);
    for (const a of annots) expect(a.lookup(PDFName.of('AP')).get(PDFName.of('N')), String(a.get(PDFName.of('Subtype')))).toBeTruthy();

    // Reopen the saved file in a new tab: pdf.js reads every annotation back.
    await page.evaluate(() => document.querySelectorAll('.viewer').forEach((v) => v.classList.add('stale-viewer')));
    await page.setInputFiles('#file-input', path);
    await page.waitForSelector('.viewer-host:not([hidden]) .viewer:not(.stale-viewer) .page[data-page-number="1"][data-state="rendered"]');
    await expect(page.getByRole('tab', { name: /annotated\.pdf/ })).toHaveAttribute('aria-selected', 'true');
    const read = await annotationsOf(page);
    for (const [s, n] of Object.entries(expected)) expect(count(read, s), s).toBe(n);
    for (const a of read) {
      expect(a.hasAppearance, a.subtype).toBe(true);
      expect(a.author, a.subtype).toBe('Ada Reviewer');
    }
    expect(read.find((a) => a.subtype === 'Text').contents).toBe('A sticky note');
    expect(read.find((a) => a.subtype === 'FreeText').contents).toBe('Hello text box');
    expect(read.find((a) => a.subtype === 'Highlight').contents).toMatch(/^The quick/);
    expect(read.find((a) => a.subtype === 'Highlight').color).toEqual([255, 212, 0]);
    expect(read.filter((a) => a.subtype === 'Line').map((a) => a.lineEndings?.[1]).sort()).toEqual(['None', 'OpenArrow']);
    expect(read.find((a) => a.subtype === 'FreeText').fontColor).toEqual([30, 35, 39]);

    // …and the reopened document's Comments panel lists them.
    await page.evaluate(() => window.pdfEditor.app.showPanel('comments'));
    await expect(threads(page)).toHaveCount(10);
    await expect(panel(page).locator('.comments-count')).toHaveText('10 comments');

    // The rectangle is drawn on the canvas (crimson pixels inside its box).
    const red = await page.evaluate(() => {
      const view = window.pdfEditor.app.viewer.views[0];
      const sq = view.annotations.find((a) => a.subtype === 'Square');
      const vp = view.baseViewport.clone({ scale: view.canvas.width / view.baseViewport.width });
      const [x0, y0] = vp.convertToViewportPoint(sq.rect[0], sq.rect[3]);
      const [x1, y1] = vp.convertToViewportPoint(sq.rect[2], sq.rect[1]);
      const { data } = view.canvas.getContext('2d').getImageData(Math.round(x0), Math.round(y0), Math.round(x1 - x0), Math.round(y1 - y0));
      let n = 0;
      for (let i = 0; i < data.length; i += 4) if (data[i] > 150 && data[i + 1] < 60 && data[i + 2] < 90) n++;
      return n;
    });
    expect(red).toBeGreaterThan(50);
  });

  test('select, move, resize, restyle and delete are undo steps; styles are remembered', async ({ page }) => {
    await openFixture(page, 'multipage.pdf');
    await page.evaluate(() => window.pdfEditor.app.annotator.activate('square'));
    // Last-used style: pick blue + width 5 for rectangles before drawing.
    await bar(page).getByRole('button', { name: 'Colour #0050c8' }).click();
    await bar(page).getByRole('combobox', { name: 'Stroke width' }).selectOption('5');
    await drag(page, [100, 400], [250, 500]);
    await stepDone(page, 'Add Rectangle');
    let [sq] = (await annotationsOf(page)).filter((a) => a.subtype === 'Square');
    expect(sq.color).toEqual([0, 80, 200]);
    const before = sq.rect;

    // The new rectangle is selected: drag its frame to move it.
    const frame = page.locator('.annot-selection');
    await expect(frame).toBeVisible();
    const scale = await page.evaluate(() => window.pdfEditor.app.viewer.layout.scale);
    const fb = await frame.boundingBox();
    await page.mouse.move(fb.x + fb.width / 2, fb.y + fb.height / 2);
    await page.mouse.down();
    await page.mouse.move(fb.x + fb.width / 2 + 50, fb.y + fb.height / 2 + 30, { steps: 6 });
    await page.mouse.up();
    await stepDone(page, 'Move Rectangle');
    [sq] = (await annotationsOf(page)).filter((a) => a.subtype === 'Square');
    expect(sq.rect[0] - before[0]).toBeCloseTo(50 / scale, 0);
    expect(sq.rect[1] - before[1]).toBeCloseTo(-30 / scale, 0);

    // Resize from the bottom-right handle.
    const handle = page.locator('.annot-selection .h-se');
    await expect(handle).toBeVisible();
    const hb = await handle.boundingBox();
    await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
    await page.mouse.down();
    await page.mouse.move(hb.x + hb.width / 2 + 40, hb.y + hb.height / 2 + 20, { steps: 6 });
    await page.mouse.up();
    await stepDone(page, 'Resize Rectangle');
    const moved = sq.rect;
    [sq] = (await annotationsOf(page)).filter((a) => a.subtype === 'Square');
    expect(sq.rect[2] - sq.rect[0]).toBeCloseTo(moved[2] - moved[0] + 40 / scale, 0);

    // Restyle the selection from the toolbar.
    await bar(page).getByRole('button', { name: 'Colour #00803c' }).click();
    await stepDone(page, 'Restyle Rectangle');
    [sq] = (await annotationsOf(page)).filter((a) => a.subtype === 'Square');
    expect(sq.color).toEqual([0, 128, 60]);

    // Delete with the keyboard; undo brings it back, redo removes it again.
    await expect(page.locator('.annot-selection')).toBeVisible();
    await page.keyboard.press('Delete');
    await stepDone(page, 'Delete Rectangle');
    expect((await annotationsOf(page)).filter((a) => a.subtype === 'Square')).toHaveLength(0);
    await page.keyboard.press('Control+z');
    await stepDone(page, 'Restyle Rectangle');
    expect((await annotationsOf(page)).filter((a) => a.subtype === 'Square')).toHaveLength(1);
    await page.keyboard.press('Control+Shift+Z');
    await stepDone(page, 'Delete Rectangle');

    // Remembered style survives a reload of the tool (prefs).
    const style = await page.evaluate(() => window.pdfEditor.app.annotator.style('square'));
    expect(style.color).toBe('#00803c');
    expect(style.width).toBe(5);

    // Esc exits annotation mode.
    await page.locator('.viewer-host:not([hidden]) .viewer').focus();
    await page.keyboard.press('Escape');
    await expect(bar(page)).toBeHidden();
  });

  test('existing annotations from the file are listed, editable and movable', async ({ page }) => {
    await openFixture(page, 'annotations.pdf');
    await page.evaluate(() => window.pdfEditor.registry.getTool('comment').run({ app: window.pdfEditor.app }));
    await expect(panel(page).locator('.side-panel-title')).toHaveText('Comments');
    await expect(threads(page)).toHaveCount(7);
    await expect(threads(page).first()).toContainText('Test Author');

    // Click the rectangle on the page (select tool) and move it.
    const box = pageIn(page, 1).locator('.annot-box[data-subtype="Square"]');
    const before = (await annotationsOf(page)).find((a) => a.subtype === 'Square');
    const bb = await box.boundingBox();
    await page.mouse.move(bb.x + 10, bb.y + 10);
    await page.mouse.down();
    await page.mouse.move(bb.x + 40, bb.y + 10, { steps: 5 });
    await page.mouse.up();
    await stepDone(page, 'Move Rectangle');
    const after = (await annotationsOf(page)).find((a) => a.subtype === 'Square');
    expect(after.rect[0]).toBeGreaterThan(before.rect[0] + 10);
    expect(after.contents).toBe('A rectangle');
    await expect(threads(page).filter({ hasText: 'A rectangle' })).toHaveClass(/selected/);

    // Edit its comment from the panel.
    const thread = threads(page).filter({ hasText: 'A rectangle' });
    await thread.getByRole('button', { name: 'Edit comment' }).click();
    await panel(page).getByRole('textbox', { name: 'Comment text' }).fill('A moved rectangle');
    await page.keyboard.press('Control+Enter');
    await stepDone(page, 'Edit comment');
    expect((await annotationsOf(page)).find((a) => a.subtype === 'Square').contents).toBe('A moved rectangle');
    await shot(page, 'm8-comments-light');
  });

  test('comments panel: replies, resolve, filters, jump-to and delete', async ({ page }) => {
    await page.evaluate(async () => {
      const { setSetting } = await import('@app/core/settings.js');
      setSetting('author', 'Grace');
    });
    await openFixture(page, 'annotations.pdf');
    await page.evaluate(() => window.pdfEditor.app.showPanel('comments'));
    await expect(threads(page)).toHaveCount(7);
    const note = threads(page).filter({ hasText: 'A sticky note' });

    // Reply.
    await note.getByRole('button', { name: 'Reply' }).click();
    await panel(page).getByRole('textbox', { name: 'Reply' }).fill('Agreed, fixing it.');
    await note.locator('.comment-editor').getByRole('button', { name: 'Reply' }).click();
    await stepDone(page, 'Reply to comment');
    await expect(note.locator('.comment-reply')).toHaveCount(1);
    await expect(note.locator('.comment-reply')).toContainText('Grace');
    await expect(note.locator('.comment-reply')).toContainText('Agreed, fixing it.');
    const replies = (await annotationsOf(page)).filter((a) => a.inReplyTo);
    expect(replies).toHaveLength(1);

    // Resolve → badge, a review state annotation; filters by status.
    await note.getByRole('button', { name: 'Resolve' }).click();
    await stepDone(page, 'Resolve comment');
    await expect(note.locator('.comment-resolved')).toHaveText('Resolved');
    expect((await annotationsOf(page)).filter((a) => a.state === 'Completed')).toHaveLength(1);
    const filters = panel(page).locator('.comments-filters');
    await filters.getByRole('combobox', { name: 'Filter by status' }).selectOption('resolved');
    await expect(threads(page)).toHaveCount(1);
    await filters.getByRole('combobox', { name: 'Filter by status' }).selectOption('open');
    await expect(threads(page)).toHaveCount(6);
    await filters.getByRole('combobox', { name: 'Filter by status' }).selectOption('');

    // Author filter includes reply authors; type filter.
    await filters.getByRole('combobox', { name: 'Filter by author' }).selectOption('Grace');
    await expect(threads(page)).toHaveCount(1);
    await filters.getByRole('combobox', { name: 'Filter by author' }).selectOption('');
    await filters.getByRole('combobox', { name: 'Filter by type' }).selectOption({ label: 'Ellipse' });
    await expect(threads(page)).toHaveCount(1);
    await filters.getByRole('combobox', { name: 'Filter by type' }).selectOption('');

    // Reopen.
    await note.getByRole('button', { name: 'Reopen' }).click();
    await stepDone(page, 'Reopen comment');
    await expect(note.locator('.comment-resolved')).toHaveCount(0);

    // Jump-to selects the annotation on the page.
    await threads(page).filter({ hasText: 'Freehand' }).click();
    await expect(page.locator('.annot-selection')).toBeVisible();
    await expect(threads(page).filter({ hasText: 'Freehand' })).toHaveClass(/selected/);

    // Delete a reply, then the whole thread (replies and states go with it).
    await note.locator('.comment-reply').getByRole('button', { name: 'Delete reply' }).click();
    await stepDone(page, 'Delete reply');
    await expect(note.locator('.comment-reply')).toHaveCount(0);
    await note.getByRole('button', { name: 'Delete comment' }).click();
    await stepDone(page, 'Delete Note');
    await expect(threads(page)).toHaveCount(6);
    expect((await annotationsOf(page)).filter((a) => a.subtype === 'Text')).toHaveLength(0);
    await page.keyboard.press('Control+z');
    await expect(threads(page)).toHaveCount(7);

    // Saved file keeps reply + state structure.
    await note.getByRole('button', { name: 'Reply' }).click();
    await panel(page).getByRole('textbox', { name: 'Reply' }).fill('Second look');
    await page.keyboard.press('Control+Enter');
    await stepDone(page, 'Reply to comment');
    const path = await save(page, 'replied.pdf');
    await page.setInputFiles('#file-input', path);
    await expect(page.getByRole('tab', { name: /replied\.pdf/ })).toHaveAttribute('aria-selected', 'true');
    await expect(threads(page).filter({ hasText: 'A sticky note' }).locator('.comment-reply')).toContainText('Second look');
  });

  test('screenshots: toolbar and comments in dark theme', async ({ page }) => {
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
    await openFixture(page, 'annotations.pdf');
    await page.evaluate(() => window.pdfEditor.registry.getTool('comment').run({ app: window.pdfEditor.app }));
    await expect(threads(page)).toHaveCount(7);
    await threads(page).filter({ hasText: 'A rectangle' }).click();
    await expect(page.locator('.annot-selection')).toBeVisible();
    await shot(page, 'm8-comments-dark');
    await tool(page, 'Text box');
    await clickOnPage(page, [300, 680]);
    await page.getByRole('textbox', { name: 'Text box text' }).fill('Typing…');
    await shot(page, 'm8-textbox-dark');
    await page.keyboard.press('Escape');
  });

  test('text boxes work like Word: draw, type, format, edit in place', async ({ page }) => {
    await openFixture(page, 'multipage.pdf');
    await page.evaluate(() => window.pdfEditor.registry.getTool('add-text').run({ app: window.pdfEditor.app }));
    await expect(bar(page).getByRole('button', { name: 'Text box', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await drag(page, [80, 380], [300, 410]);
    const area = page.getByRole('textbox', { name: 'Text box text' });
    await expect(area).toBeFocused();
    await page.keyboard.type('A Word style text box whose text is long enough to wrap onto several lines.');
    await page.keyboard.press('Control+b');
    await expect(bar(page).getByRole('button', { name: 'Bold' })).toHaveAttribute('aria-pressed', 'true');
    await bar(page).getByRole('combobox', { name: 'Font', exact: true }).selectOption('Times');
    await bar(page).getByRole('combobox', { name: 'Font size' }).selectOption('18');
    await bar(page).getByRole('button', { name: 'Center' }).click();
    await bar(page).getByRole('combobox', { name: 'Fill colour' }).selectOption({ label: 'Yellow' });
    await bar(page).getByRole('combobox', { name: 'Border' }).selectOption({ label: 'Black' });
    await expect(area).toHaveCSS('font-weight', '700');
    await expect(area).toHaveCSS('text-align', 'center');
    await shot(page, 'm8-textbox-word-light');
    // Click outside: saved as one step; back to the Select tool; the box is selected.
    await clickOnPage(page, [600, 760]);
    await stepDone(page, 'Add Text box');
    await expect(area).toHaveCount(0);
    await expect(bar(page).getByRole('button', { name: 'Select', exact: true })).toHaveAttribute('aria-pressed', 'true');
    const spec = () => page.evaluate(async () => {
      const app = window.pdfEditor.app;
      const proxy = await app.activeTab.pdf.getPage(1);
      const ft = (await proxy.getAnnotations()).find((a) => a.subtype === 'FreeText');
      return app.activeTab.model.query('annotationSpec', { page: 0, id: ft.id });
    });
    let s = await spec();
    expect(s).toMatchObject({ type: 'freetext', fontFamily: 'Times', bold: true, italic: false, align: 'center', fontSize: 18, fill: '#fff3a3', border: '#1e2327' });
    expect(s.text).toMatch(/^A Word style text box/);
    // The text wrapped, so the box grew taller than the 30 px drawn.
    const scale = await page.evaluate(() => window.pdfEditor.app.viewer.layout.scale);
    expect(s.rect[3] - s.rect[1]).toBeGreaterThan(18 * 1.2 * 2);
    expect(s.rect[3] - s.rect[1]).toBeGreaterThan(30 / scale);

    // Restyle the selected box from the toolbar (one step).
    await expect(page.locator('.annot-selection')).toBeVisible();
    await bar(page).getByRole('button', { name: 'Italic' }).click();
    await stepDone(page, 'Restyle Text box');
    expect((await spec()).italic).toBe(true);

    // Double-click to edit the text in place; Esc finishes (keeps the text).
    // (The box is selected, so this lands on its selection frame.)
    await page.locator('.annot-selection').dblclick();
    await expect(area).toBeFocused();
    await expect(area).toHaveValue(/^A Word style text box/);
    await page.keyboard.press('Control+End');
    await page.keyboard.type(' Edited!');
    await page.keyboard.press('Escape');
    await stepDone(page, 'Edit Text box');
    s = await spec();
    expect(s.text).toMatch(/Edited!$/);
    expect(s).toMatchObject({ fontFamily: 'Times', bold: true, italic: true });
    await page.keyboard.press('Control+z');
    await stepDone(page, 'Restyle Text box');
    expect((await spec()).text).not.toMatch(/Edited!$/);
    await page.keyboard.press('Control+Shift+Z');
    await stepDone(page, 'Edit Text box');

    // Saved and reopened: a real FreeText annotation with its appearance; the style round-trips.
    const path = await save(page, 'textbox.pdf');
    await page.evaluate(() => document.querySelectorAll('.viewer').forEach((v) => v.classList.add('stale-viewer')));
    await page.setInputFiles('#file-input', path);
    await page.waitForSelector('.viewer-host:not([hidden]) .viewer:not(.stale-viewer) .page[data-page-number="1"][data-state="rendered"]');
    const ft = (await annotationsOf(page)).find((a) => a.subtype === 'FreeText');
    expect(ft.hasAppearance).toBe(true);
    expect(ft.contents).toMatch(/Edited!$/);
    expect(await spec()).toMatchObject({ fontFamily: 'Times', bold: true, italic: true, align: 'center', fill: '#fff3a3' });
  });
});

