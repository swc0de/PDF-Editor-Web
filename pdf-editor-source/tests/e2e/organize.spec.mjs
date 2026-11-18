import { test, expect, openApp, openFixture, fixture, viewerState, shot } from './helpers.mjs';

const tile = (page, i) => page.locator(`.org-tile[data-index="${i}"]`);
const grid = (page) => page.getByRole('listbox', { name: 'Pages' });
const count = (page) => page.locator('.org-count');

/** First text item of each page of the active tab ("Page 3 of 12", "Introduction", "" for blank). */
function headings(page) {
  return page.evaluate(async () => {
    const tab = window.pdfEditor.app.activeTab;
    const out = [];
    for (let i = 1; i <= tab.pdf.numPages; i++) {
      const tc = await (await tab.pdf.getPage(i)).getTextContent();
      out.push(tc.items.find((x) => x.str.trim())?.str ?? '');
    }
    return out;
  });
}

/** Page numbers from "Page n of 12" headings (multipage.pdf), 0 for others. */
async function order(page) {
  return (await headings(page)).map((s) => Number(/^Page (\d+) of/.exec(s)?.[1] ?? 0));
}

const labels = (page) => page.evaluate(() => window.pdfEditor.app.activeTab.model.history.entries.map((e) => e.label));
const lastLabel = async (page) => (await labels(page)).at(-1);
const settle = (page) => expect.poll(() => page.evaluate(() => !window.pdfEditor.app.activeTab.model.busy)).toBe(true);
/** Wait until the newest undo step is `label` and nothing is running. */
async function stepDone(page, label) {
  await expect.poll(() => lastLabel(page)).toBe(label);
  await settle(page);
}

/** Press a key that undoes/redoes and wait until the history index moved. */
async function historyKey(page, key) {
  const before = await page.evaluate(() => window.pdfEditor.app.activeTab.model.history.index);
  await page.keyboard.press(key);
  await expect.poll(() => page.evaluate(() => window.pdfEditor.app.activeTab.model.history.index)).not.toBe(before);
  await settle(page);
}

async function openOrganizer(page, file = 'multipage.pdf') {
  await openApp(page);
  await openFixture(page, file);
  await page.locator('.tool-row[data-tool="organize-pages"]').click();
  await expect(grid(page)).toBeFocused();
  try {
    await expect(tile(page, 0)).toHaveAttribute('data-state', 'rendered');
  } catch (err) {
    const st = await page.evaluate(() => {
      const o = window.pdfEditor.app.activeTab.organizer;
      return { busy: o.thumbBusy, queue: o.thumbQueue.slice(0, 8), tiles: o.tiles.size, t0: !!o.tiles.get(0)?.thumb, el0: o.tiles.get(0)?.el.isConnected,
        states: [...document.querySelectorAll('.org-tile')].slice(0, 5).map((e) => e.dataset.index + ':' + e.dataset.state), thumbs: window.pdfEditor.app.activeTab.thumbs?.size };
    });
    console.log('STUCK', JSON.stringify(st));
    throw err;
  }
}

async function selectMenu(page, name) {
  await page.locator('.org-menu-btn', { hasText: 'Select' }).click();
  await page.getByRole('menu', { name: 'Select' }).getByRole('menuitem', { name }).click();
}

async function insertMenu(page, name) {
  await page.locator('.org-menu-btn', { hasText: 'Insert' }).click();
  await page.getByRole('menu', { name: 'Insert' }).getByRole('menuitem', { name, exact: true }).click();
}

const action = (page, name) => page.locator('.org-toolbar').getByRole('button', { name, exact: true });

test.describe('selection', () => {
  test('click, Ctrl-click, Shift-click, menu and keyboard selection', async ({ page }) => {
    await openOrganizer(page);
    await expect(tile(page, 0)).toHaveAttribute('aria-selected', 'true'); // starts on the current page
    await expect(count(page)).toHaveText('1 of 12 selected');

    await tile(page, 2).click();
    await tile(page, 4).click({ modifiers: ['Control'] });
    await expect(count(page)).toHaveText('2 of 12 selected');
    await tile(page, 7).click({ modifiers: ['Shift'] });
    await expect(count(page)).toHaveText('4 of 12 selected'); // 5..8 from anchor 4
    for (const i of [4, 5, 6, 7]) await expect(tile(page, i)).toHaveAttribute('aria-selected', 'true');
    await expect(tile(page, 2)).toHaveAttribute('aria-selected', 'false');

    await selectMenu(page, 'Select all');
    await expect(count(page)).toHaveText('12 of 12 selected');
    await selectMenu(page, 'Select none');
    await expect(count(page)).toHaveText('12 pages');
    await selectMenu(page, 'Odd pages');
    await expect(count(page)).toHaveText('6 of 12 selected');
    await expect(tile(page, 0)).toHaveAttribute('aria-selected', 'true');
    await expect(tile(page, 1)).toHaveAttribute('aria-selected', 'false');
    await selectMenu(page, 'Invert selection');
    await expect(tile(page, 1)).toHaveAttribute('aria-selected', 'true');
    await expect(tile(page, 0)).toHaveAttribute('aria-selected', 'false');
    await selectMenu(page, 'Even pages');
    await expect(count(page)).toHaveText('6 of 12 selected');

    // Keyboard: arrows move, Shift extends, Ctrl+A selects all.
    await tile(page, 0).click();
    await page.keyboard.press('ArrowRight');
    await expect(grid(page)).toHaveAttribute('aria-activedescendant', /tile-1$/);
    await page.keyboard.press('Shift+ArrowRight');
    await page.keyboard.press('Shift+ArrowRight');
    await expect(count(page)).toHaveText('3 of 12 selected');
    await page.keyboard.press('Control+a');
    await expect(count(page)).toHaveText('12 of 12 selected');

    // Enter opens the focused page in the viewer.
    await tile(page, 5).click();
    await page.keyboard.press('Enter');
    await expect(page.locator('.organizer')).toBeHidden();
    await expect.poll(async () => (await viewerState(page)).page).toBe(6);
  });
});

test.describe('actions (each one undo step)', () => {
  test('rotate, delete, duplicate — and undo', async ({ page }) => {
    await openOrganizer(page);
    await tile(page, 1).click();
    await tile(page, 3).click({ modifiers: ['Control'] });
    await action(page, 'Rotate right').click();
    await stepDone(page, 'Rotate 2 pages');
    const rot = () => page.evaluate(() => window.pdfEditor.app.viewer.sizes.map((s) => s.rotate));
    expect((await rot()).slice(0, 4)).toEqual([0, 90, 0, 90]);
    await expect(tile(page, 1).locator('.org-page')).toHaveCSS('width', /.*/); // still rendered
    await action(page, 'Rotate left').click();
    await stepDone(page, 'Rotate 2 pages left');
    expect((await rot()).slice(0, 4)).toEqual([0, 0, 0, 0]);

    // Delete pages 2 and 4 (still selected).
    await page.keyboard.press('Delete');
    await stepDone(page, 'Delete 2 pages');
    expect(await order(page)).toEqual([1, 3, 5, 6, 7, 8, 9, 10, 11, 12]);
    await expect(page.locator('.org-tile')).toHaveCount(10);

    // Duplicate pages 1 and 3 (indexes 0, 1 now) with Ctrl+D.
    await tile(page, 0).click();
    await tile(page, 1).click({ modifiers: ['Control'] });
    await page.keyboard.press('Control+d');
    await stepDone(page, 'Duplicate 2 pages');
    expect((await order(page)).slice(0, 5)).toEqual([1, 1, 3, 3, 5]);
    await expect(count(page)).toHaveText('2 of 12 selected'); // the copies

    // Undo all three steps.
    await historyKey(page, 'Control+z');
    expect(await order(page)).toEqual([1, 3, 5, 6, 7, 8, 9, 10, 11, 12]);
    await historyKey(page, 'Control+z');
    expect(await order(page)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    await expect(page.locator('.org-tile')).toHaveCount(12);
  });

  test('deleting every page is refused', async ({ page }) => {
    await openOrganizer(page);
    await page.keyboard.press('Control+a');
    await page.keyboard.press('Delete');
    await expect(page.locator('.toast')).toContainText('needs at least one page');
    expect(await page.evaluate(() => window.pdfEditor.app.activeTab.model.canUndo)).toBe(false);
  });

  test('insert blank pages (neighbour size, A4, Letter)', async ({ page }) => {
    await openOrganizer(page, 'mixed-sizes.pdf');
    const view = (i) => page.evaluate((i) => window.pdfEditor.app.viewer.sizes[i], i);
    await tile(page, 2).click(); // A5 landscape
    await insertMenu(page, 'Blank page before');
    await stepDone(page, 'Insert blank page');
    expect(await page.evaluate(() => window.pdfEditor.app.viewer.numPages)).toBe(7);
    const blank = await view(2);
    const a5 = await view(3);
    expect([Math.round(blank.w), Math.round(blank.h)]).toEqual([Math.round(a5.w), Math.round(a5.h)]);
    expect((await headings(page))[2]).toBe('');
    await expect(tile(page, 2)).toHaveAttribute('aria-selected', 'true'); // the new page

    await insertMenu(page, 'Blank A4 page after');
    await settle(page);
    const a4 = await view(3);
    expect([Math.round(a4.w), Math.round(a4.h)]).toEqual([595, 842]);
    await insertMenu(page, 'Blank Letter page after');
    await settle(page);
    const letter = await view(4);
    expect([letter.w, letter.h]).toEqual([612, 792]);

    // A blank page after the rotated last page inherits its rotation.
    await tile(page, 8).click();
    await insertMenu(page, 'Blank page after');
    await settle(page);
    expect((await view(9)).rotate).toBe(90);
    for (let i = 0; i < 4; i++) {
      await historyKey(page, 'Control+z');
    }
    expect(await page.evaluate(() => window.pdfEditor.app.viewer.numPages)).toBe(6);
  });

  test('insert pages from another PDF with a page range and position', async ({ page }) => {
    await openOrganizer(page);
    await tile(page, 1).click();
    await insertMenu(page, 'Pages from a PDF…');
    const dialog = page.getByRole('dialog', { name: 'Insert pages from a PDF' });
    // Validation: no file yet.
    await dialog.getByRole('button', { name: 'Insert', exact: true }).click();
    await expect(dialog.getByRole('alert')).toHaveText('Choose a PDF first.');
    await dialog.locator('#insert-file-input').setInputFiles(fixture('outline.pdf'));
    await expect(dialog.locator('.insert-file-name')).toHaveText('outline.pdf — 10 pages');
    await dialog.getByLabel('Pages to insert').fill('1, 3, 99');
    await dialog.getByRole('button', { name: 'Insert', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText('“99” isn’t a valid page range');
    await dialog.getByLabel('Pages to insert').fill('1, 3');
    // Default position: after the selected page (2).
    await expect(dialog.getByLabel('Page number')).toHaveValue('2');
    await dialog.getByRole('button', { name: 'Insert', exact: true }).click();
    await expect(dialog).toBeHidden();
    await stepDone(page, 'Insert 2 pages from outline.pdf');
    expect((await headings(page)).slice(0, 5)).toEqual(['Page 1 of 12', 'Page 2 of 12', 'Introduction', 'Chapter 1', 'Page 3 of 12']);
    await expect(count(page)).toHaveText('2 of 14 selected');

    // At the beginning, all pages.
    await insertMenu(page, 'Pages from a PDF…');
    await dialog.locator('#insert-file-input').setInputFiles(fixture('annotations.pdf'));
    await dialog.getByLabel('Insert', { exact: true }).selectOption('start');
    await expect(dialog.getByLabel('Page number')).toBeDisabled();
    await dialog.getByRole('button', { name: 'Insert', exact: true }).click();
    await stepDone(page, 'Insert 2 pages from annotations.pdf');
    expect((await headings(page)).slice(0, 3)).toEqual(['Annotated page', 'Link target', 'Page 1 of 12']);
    expect(await page.evaluate(() => window.pdfEditor.app.viewer.numPages)).toBe(16);
  });

  test('extract the selection to a new tab', async ({ page }) => {
    await openOrganizer(page);
    await tile(page, 1).click();
    await tile(page, 4).click({ modifiers: ['Control'] });
    await action(page, 'Extract to new tab').click();
    await expect(page.getByRole('tab')).toHaveCount(2);
    await expect(page.locator('.tab-item.active .tab-name')).toHaveText('multipage (pages 2, 5).pdf');
    await expect(page.locator('.tab-item.active .tab-dirty')).toBeVisible(); // not saved anywhere yet
    expect(await order(page)).toEqual([2, 5]);
    expect(await lastLabel(page)).toBe('Extracted from multipage.pdf');
    await page.getByRole('tab', { name: 'multipage.pdf', exact: true }).click();
    expect((await order(page)).length).toBe(12);
  });
});

test.describe('reordering', () => {
  test('drag and drop several pages with a drop indicator', async ({ page }) => {
    await openOrganizer(page);
    await tile(page, 0).click();
    await tile(page, 1).click({ modifiers: ['Control'] });
    const from = await tile(page, 0).boundingBox();
    const to5 = await tile(page, 4).boundingBox();
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    // Drop on the right half of page 5 → after page 5.
    await page.mouse.move(to5.x + to5.width * 0.85, to5.y + to5.height / 2, { steps: 8 });
    await expect(page.locator('.org-drop')).toBeVisible();
    await expect(page.locator('.org-drop')).toHaveAttribute('data-target', '5');
    await expect(page.locator('.org-ghost-count')).toHaveText('2');
    await page.mouse.up();
    await stepDone(page, 'Move 2 pages');
    expect(await order(page)).toEqual([3, 4, 5, 1, 2, 6, 7, 8, 9, 10, 11, 12]);
    await expect(tile(page, 3)).toHaveAttribute('aria-selected', 'true');
    await expect(tile(page, 4)).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('.org-drop')).toBeHidden();
    // One undo restores the order.
    await historyKey(page, 'Control+z');
    expect(await order(page)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });

  test('Esc cancels a drag', async ({ page }) => {
    await openOrganizer(page);
    const a = await tile(page, 0).boundingBox();
    const b = await tile(page, 3).boundingBox();
    await page.mouse.move(a.x + 20, a.y + 20);
    await page.mouse.down();
    await page.mouse.move(b.x + 10, b.y + 20, { steps: 6 });
    await page.keyboard.press('Escape');
    await page.mouse.up();
    await expect(page.locator('.organizer')).toBeVisible();
    expect(await page.evaluate(() => window.pdfEditor.app.activeTab.model.canUndo)).toBe(false);
  });

  test('Ctrl+←/→ move the selection; bookmarks follow their pages', async ({ page }) => {
    await openOrganizer(page, 'outline.pdf');
    await tile(page, 2).click(); // "Chapter 1"
    await page.keyboard.press('Control+ArrowRight');
    await stepDone(page, 'Move 1 page');
    expect((await headings(page)).slice(2, 4)).toEqual(['Page 4', 'Chapter 1']);
    await historyKey(page, 'Control+ArrowLeft');
    await historyKey(page, 'Control+ArrowLeft');
    expect((await headings(page)).slice(0, 3)).toEqual(['Introduction', 'Chapter 1', 'Part One']);

    // Bookmark "Chapter 1" now jumps to page 2.
    await page.getByRole('button', { name: 'Done' }).click();
    await page.locator('.rail').getByRole('button', { name: 'Bookmarks' }).click();
    await page.getByRole('treeitem', { name: 'Chapter 1', exact: true }).locator('.tree-row').click();
    await expect.poll(async () => (await viewerState(page)).page).toBe(2);

    // Deleting a page removes the bookmarks that pointed to it.
    await page.locator('.tool-row[data-tool="organize-pages"]').click();
    await tile(page, 9).click(); // Appendix
    await page.keyboard.press('Delete');
    await stepDone(page, 'Delete 1 page');
    await page.getByRole('button', { name: 'Done' }).click();
    await expect(page.getByRole('tree')).not.toContainText('Appendix');
    await expect(page.getByRole('treeitem', { name: 'Introduction', exact: true })).toBeVisible();
  });
});

test('large documents are windowed and stay quick', async ({ page }) => {
  test.setTimeout(60_000);
  await openOrganizer(page, 'large.pdf');
  expect(await page.locator('.org-tile').count()).toBeLessThan(120);
  await expect(grid(page)).toHaveAttribute('aria-multiselectable', 'true');
  await page.keyboard.press('End');
  await expect(tile(page, 499)).toBeVisible();
  await expect(tile(page, 499)).toHaveAttribute('aria-setsize', '500');
  await expect(tile(page, 499)).toHaveAttribute('data-state', 'rendered');
  expect(await page.locator('.org-tile').count()).toBeLessThan(120);
  await expect(tile(page, 0)).toHaveCount(0);
  // Delete the last page: one step, 499 left.
  await page.keyboard.press('Delete');
  await stepDone(page, 'Delete 1 page');
  expect(await page.evaluate(() => window.pdfEditor.app.viewer.numPages)).toBe(499);
});

test('organize, save and reopen keeps the new order', async ({ page }) => {
  await openOrganizer(page);
  await tile(page, 11).click();
  await page.keyboard.press('Home');
  await page.keyboard.press('Shift+End'); // select all from 1..12, then keep only last via click
  await tile(page, 11).click();
  for (let i = 0; i < 11; i++) await historyKey(page, 'Control+ArrowLeft');
  expect((await order(page))[0]).toBe(12);
  const download = page.waitForEvent('download');
  await page.keyboard.press('Control+s');
  const path = test.info().outputPath('reordered.pdf');
  await (await download).saveAs(path);
  await page.setInputFiles('#file-input', path);
  await expect(page.getByRole('tab')).toHaveCount(2);
  await expect.poll(async () => (await order(page))[0]).toBe(12);
});

test('screenshots: organizer in light and dark', async ({ page }) => {
  for (const theme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: theme });
    await openOrganizer(page, 'mixed-sizes.pdf');
    await tile(page, 1).click();
    await tile(page, 3).click({ modifiers: ['Control'] });
    await page.waitForTimeout(300);
    await shot(page, `m5-organizer-${theme}`);
    const a = await tile(page, 1).boundingBox();
    const b = await tile(page, 5).boundingBox();
    await page.mouse.move(a.x + 30, a.y + 30);
    await page.mouse.down();
    await page.mouse.move(b.x + 10, b.y + 40, { steps: 6 });
    await shot(page, `m5-drag-${theme}`);
    await page.keyboard.press('Escape');
    await page.mouse.up();
    await insertMenu(page, 'Pages from a PDF…');
    await page.locator('#insert-file-input').setInputFiles(fixture('outline.pdf'));
    await shot(page, `m5-insert-${theme}`);
    await page.keyboard.press('Escape');
  }
});
