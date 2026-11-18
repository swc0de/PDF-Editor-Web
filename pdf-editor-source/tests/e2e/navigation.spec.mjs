import { test, expect, openApp, openFixture, viewerState, pageIn, manifest, shot, reloadApp } from './helpers.mjs';

const findBar = (page) => page.getByRole('search', { name: 'Find in document' });
const findInput = (page) => findBar(page).getByRole('searchbox');
const counter = (page) => findBar(page).locator('.find-count');
const findState = (page) => page.evaluate(() => window.pdfEditor.app.activeTab.find?.state ?? null);

async function find(page, query) {
  await page.keyboard.press('Control+f');
  await expect(findInput(page)).toBeFocused();
  await findInput(page).fill(query);
  await expect.poll(async () => {
    const s = await findState(page);
    return s?.query === query && s.complete;
  }).toBe(true);
}

test.describe('find', () => {
  test('counts, next/previous, wrap-around and highlights', async ({ page }) => {
    await openApp(page);
    await openFixture(page, 'multipage.pdf');
    await find(page, 'quokka');
    const expected = manifest['multipage.pdf'].search.quokka;
    await expect(counter(page)).toHaveText(`1 of ${expected}`);
    // The first match (page 2) is visible and marked as current.
    await expect.poll(async () => (await viewerState(page)).page).toBe(2);
    const selected = pageIn(page, 2).locator('.textLayer .highlight.selected');
    await expect(selected).toHaveText('quokka');
    await expect(selected).toBeInViewport();

    await findInput(page).press('Enter');
    await expect(counter(page)).toHaveText(`2 of ${expected}`);
    await findInput(page).press('Shift+Enter');
    await expect(counter(page)).toHaveText(`1 of ${expected}`);
    await page.keyboard.press('Control+g');
    await page.keyboard.press('Control+g');
    await page.keyboard.press('Control+g');
    await expect(counter(page)).toHaveText(`4 of ${expected}`);
    // Two matches on page 9, the current one highlighted differently.
    await expect(pageIn(page, 9).locator('.textLayer .highlight')).toHaveCount(2);
    await expect(pageIn(page, 9).locator('.textLayer .highlight.selected')).toBeInViewport();
    await page.keyboard.press('Control+g');
    await expect(counter(page)).toHaveText(`1 of ${expected}`); // wraps
    await page.keyboard.press('Control+Shift+G');
    await expect(counter(page)).toHaveText(`4 of ${expected}`);

    // Esc closes and removes the highlights (text restored).
    await findInput(page).press('Escape');
    await expect(findBar(page)).toBeHidden();
    await expect(page.locator('.textLayer .highlight')).toHaveCount(0);
    await expect(pageIn(page, 9).locator('.textLayer')).toContainText('Quokka facts: the quokka lives');
  });

  test('match case and whole word', async ({ page }) => {
    await openApp(page);
    await openFixture(page, 'multipage.pdf');
    await find(page, 'Quokka');
    await expect(counter(page)).toHaveText('1 of 4');
    await findBar(page).getByRole('button', { name: 'Match case' }).click();
    await expect(findBar(page).getByRole('button', { name: 'Match case' })).toHaveAttribute('aria-pressed', 'true');
    await expect(counter(page)).toHaveText(`1 of ${manifest['multipage.pdf'].search.quokkaMatchCase.Quokka}`);

    await findBar(page).getByRole('button', { name: 'Match case' }).click();
    // (A new search starts from the current page, so the ordinal varies.)
    await expect(counter(page)).toHaveText(/^\d of 4$/);
    await findInput(page).fill('quokk');
    await expect(counter(page)).toHaveText(/^\d of 4$/);
    await findBar(page).getByRole('button', { name: 'Whole words' }).click();
    await expect(counter(page)).toHaveText('No results');
    await expect(findBar(page)).toHaveAttribute('data-state', 'none');

    // Multi-word queries match across spaces; markers are whole words.
    await findInput(page).fill('page-marker-07');
    await expect(counter(page)).toHaveText('1 of 1');
    await expect.poll(async () => (await viewerState(page)).page).toBe(7);
  });

  test('search counts on the fixtures', async ({ page }) => {
    await openApp(page);
    const cases = [
      ['multipage.pdf', 'the', null],
      ['outline.pdf', 'chapter', 3],
      ['page-labels.pdf', 'label', 10],
      ['annotations.pdf', 'highlighted', 1],
    ];
    for (const [file, query, count] of cases) {
      await openFixture(page, file);
      await find(page, query);
      const s = await findState(page);
      if (count !== null) expect(s.total, `${file}: "${query}"`).toBe(count);
      else expect(s.total).toBeGreaterThan(12);
      await findInput(page).press('Escape');
    }
  });

  test('a 500-page document is indexed in the background and stays responsive', async ({ page }) => {
    test.setTimeout(60_000);
    await openApp(page);
    await openFixture(page, 'large.pdf');
    await page.keyboard.press('Control+f');
    await findInput(page).fill('Large document');
    // While indexing, the counter shows a partial count ("n of m+").
    await expect(counter(page)).toHaveText(/^1 of \d+\+?$/);
    await expect.poll(async () => (await findState(page)).complete, { timeout: 30_000 }).toBe(true);
    await expect(counter(page)).toHaveText('1 of 500');
    await page.keyboard.press('Control+Shift+G');
    await expect(counter(page)).toHaveText('500 of 500');
    await expect.poll(async () => (await viewerState(page)).page).toBe(500);
    await expect(pageIn(page, 500).locator('.highlight.selected')).toBeInViewport();
  });

  test('find follows the active tab; the Find text tool opens it', async ({ page }) => {
    await openApp(page);
    await openFixture(page, 'multipage.pdf');
    await openFixture(page, 'outline.pdf');
    await page.locator('.tool-row[data-tool="find"]').click();
    await expect(findInput(page)).toBeFocused();
    await findInput(page).fill('chapter');
    await expect(counter(page)).toHaveText('1 of 3');
    await page.getByRole('tab', { name: 'multipage.pdf' }).click();
    await expect(counter(page)).toHaveText('No results');
    await page.getByRole('tab', { name: 'outline.pdf' }).click();
    await expect(counter(page)).toHaveText('1 of 3');
  });
});

test.describe('pages panel', () => {
  test('lazy thumbnails, size slider, current page, click to jump', async ({ page }) => {
    await openApp(page);
    await openFixture(page, 'large.pdf');
    await page.locator('.rail').getByRole('button', { name: 'Pages' }).click();
    const panel = page.locator('#side-panel');
    const thumbs = panel.locator('.thumb');
    await expect(thumbs).toHaveCount(500);
    await expect(thumbs.first()).toHaveAttribute('data-state', 'rendered');
    await expect(thumbs.first()).toHaveAttribute('aria-selected', 'true');
    // Only thumbnails near the visible area are rendered.
    await page.waitForTimeout(300);
    const rendered = await panel.locator('.thumb[data-state="rendered"]').count();
    expect(rendered).toBeGreaterThan(2);
    expect(rendered).toBeLessThan(40);

    // Scrolling the panel renders more.
    await panel.locator('.thumb-scroller').evaluate((el) => { el.scrollTop = el.scrollHeight / 2; });
    await expect(thumbs.nth(250)).toHaveAttribute('data-state', 'rendered', { timeout: 10_000 });

    // Click a thumbnail → that page.
    await thumbs.nth(250).click();
    await expect.poll(async () => (await viewerState(page)).page).toBe(251);
    await expect(thumbs.nth(250)).toHaveAttribute('aria-selected', 'true');
    // Keyboard: → moves to the next page.
    await page.keyboard.press('ArrowRight');
    await expect.poll(async () => (await viewerState(page)).page).toBe(252);
    // Viewer navigation updates the panel.
    await page.locator('.page-input').fill('3');
    await page.locator('.page-input').press('Enter');
    await expect(thumbs.nth(2)).toHaveAttribute('aria-selected', 'true');
    await expect(thumbs.nth(2)).toBeInViewport();

    // Size slider: 50–150%, remembered.
    const slider = panel.getByRole('slider', { name: 'Thumbnail size' });
    await expect(slider).toHaveAttribute('min', '50');
    await expect(slider).toHaveAttribute('max', '150');
    const w100 = await thumbs.first().locator('.thumb-frame').evaluate((el) => el.offsetWidth);
    await slider.fill('150');
    const w150 = await thumbs.first().locator('.thumb-frame').evaluate((el) => el.offsetWidth);
    expect(w150).toBeCloseTo(w100 * 1.5, 0);
    await slider.fill('50');
    expect(await thumbs.first().locator('.thumb-frame').evaluate((el) => el.offsetWidth)).toBeCloseTo(w100 * 0.5, 0);
    await reloadApp(page);
    await openFixture(page, 'multipage.pdf');
    await expect(page.locator('#side-panel').getByRole('slider')).toHaveValue('50');
  });
});

test.describe('bookmarks panel', () => {
  test('outline tree: expand/collapse, click to jump, keyboard', async ({ page }) => {
    await openApp(page);
    await openFixture(page, 'outline.pdf');
    await page.locator('.rail').getByRole('button', { name: 'Bookmarks' }).click();
    const tree = page.getByRole('tree', { name: 'Bookmarks' });
    const item = (name) => tree.getByRole('treeitem', { name, exact: true });
    await expect(item('Introduction')).toBeVisible();
    // "Part One" is stored open; "Chapter 2" and "Part Two" closed.
    await expect(item('Part One')).toHaveAttribute('aria-expanded', 'true');
    await expect(item('Chapter 1')).toBeVisible();
    await expect(item('Chapter 2')).toHaveAttribute('aria-expanded', 'false');
    await expect(item('Section 2.1')).toBeHidden();
    await expect(item('Chapter 3')).toBeHidden();

    await item('Appendix').locator('.tree-row').click();
    await expect.poll(async () => (await viewerState(page)).page).toBe(10);
    await item('Chapter 2').locator('.tree-toggle').first().click();
    await expect(item('Section 2.1')).toBeVisible();
    await item('Section 2.1').locator('.tree-row').click();
    await expect.poll(async () => (await viewerState(page)).page).toBe(6);

    // Keyboard: focus Introduction, ↓ to Part One, ← collapses, → expands, → into Chapter 1, Enter jumps.
    await item('Introduction').focus();
    await page.keyboard.press('ArrowDown');
    await expect(item('Part One')).toBeFocused();
    await page.keyboard.press('ArrowLeft');
    await expect(item('Part One')).toHaveAttribute('aria-expanded', 'false');
    await page.keyboard.press('ArrowRight');
    await expect(item('Part One')).toHaveAttribute('aria-expanded', 'true');
    await page.keyboard.press('ArrowRight');
    await expect(item('Chapter 1')).toBeFocused();
    await page.keyboard.press('Enter');
    await expect.poll(async () => (await viewerState(page)).page).toBe(3);
    await page.keyboard.press('ArrowLeft');
    await expect(item('Part One')).toBeFocused();
  });

  test('search keeps the ancestors of matches visible', async ({ page }) => {
    await openApp(page);
    await openFixture(page, 'outline.pdf');
    await page.locator('.rail').getByRole('button', { name: 'Bookmarks' }).click();
    const tree = page.getByRole('tree');
    const item = (name) => tree.getByRole('treeitem', { name, exact: true });
    const search = page.getByRole('searchbox', { name: 'Search bookmarks' });
    await search.fill('section');
    await expect(item('Section 2.1')).toBeVisible();
    await expect(item('Section 2.1').locator('mark')).toHaveText('Section');
    await expect(item('Chapter 2')).toBeVisible();
    await expect(item('Part One')).toBeVisible();
    await expect(item('Introduction')).toBeHidden();
    await expect(item('Chapter 1')).toBeHidden();
    await expect(item('Part Two')).toBeHidden();
    await expect(page.locator('.bookmark-status')).toHaveText('1 matching');
    await search.fill('zzz');
    await expect(page.locator('.bookmark-status')).toHaveText('No bookmarks match.');
    await search.fill('');
    await expect(item('Introduction')).toBeVisible();
    await expect(item('Section 2.1')).toBeHidden(); // original expansion restored
  });

  test('documents without an outline say so', async ({ page }) => {
    await openApp(page);
    await openFixture(page, 'multipage.pdf');
    await page.locator('.tool-row[data-tool="bookmarks"]').click();
    await expect(page.locator('#side-panel')).toContainText('This document has no bookmarks.');
  });
});

test.describe('page labels', () => {
  test('shown in the status bar and thumbnails; the page box accepts labels', async ({ page }) => {
    await openApp(page);
    await openFixture(page, 'page-labels.pdf');
    const input = page.locator('.page-input');
    await expect(input).toHaveValue('i');
    await expect(page.locator('.page-total')).toHaveText('(1 of 10)');

    const go = async (text) => {
      await input.fill(text);
      await input.press('Enter');
    };
    await go('iv');
    await expect.poll(async () => (await viewerState(page)).page).toBe(4);
    await expect(input).toHaveValue('iv');
    await go('A-2');
    await expect.poll(async () => (await viewerState(page)).page).toBe(10);
    await go('a-1'); // case-insensitive
    await expect.poll(async () => (await viewerState(page)).page).toBe(9);
    await go('3'); // a label wins over a page number
    await expect.poll(async () => (await viewerState(page)).page).toBe(7);
    await expect(page.locator('.page-total')).toHaveText('(7 of 10)');
    await go('9'); // not a label → page number
    await expect.poll(async () => (await viewerState(page)).page).toBe(9);
    await go('xyz'); // nothing → restored
    await expect(input).toHaveValue('A-1');

    await page.locator('.tool-row[data-tool="page-thumbnails"]').click();
    const labels = await page.locator('#side-panel .thumb-label').allTextContents();
    expect(labels).toEqual(manifest['page-labels.pdf'].labels);
    await expect(page.locator('#side-panel .thumb').nth(3)).toHaveAttribute('aria-label', 'Page iv (4)');
  });
});

test.describe('history', () => {
  test('Alt+← / Alt+→ after link jumps, outline jumps and page jumps', async ({ page }) => {
    await openApp(page);
    await openFixture(page, 'annotations.pdf');
    await page.evaluate(() => window.pdfEditor.app.viewer.setZoom(1));
    await pageIn(page, 1).locator('a.pdf-link[data-dest]').click();
    await expect.poll(async () => (await viewerState(page)).page).toBe(2);
    await page.keyboard.press('Alt+ArrowLeft');
    await expect.poll(async () => (await viewerState(page)).page).toBe(1);
    await page.keyboard.press('Alt+ArrowRight');
    await expect.poll(async () => (await viewerState(page)).page).toBe(2);

    await openFixture(page, 'outline.pdf');
    await page.locator('.page-input').fill('4');
    await page.locator('.page-input').press('Enter');
    await page.locator('.rail').getByRole('button', { name: 'Bookmarks' }).click();
    await page.getByRole('treeitem', { name: 'Appendix' }).locator('.tree-row').click();
    await expect.poll(async () => (await viewerState(page)).page).toBe(10);
    await page.locator('.viewer-host:not([hidden]) .viewer').focus();
    await page.keyboard.press('Alt+ArrowLeft');
    await expect.poll(async () => (await viewerState(page)).page).toBe(4);
    await page.keyboard.press('Alt+ArrowLeft');
    await expect.poll(async () => (await viewerState(page)).page).toBe(1);
    // Nothing further back: stays put.
    await page.keyboard.press('Alt+ArrowLeft');
    expect((await viewerState(page)).page).toBe(1);
    await page.getByRole('menuitem', { name: 'View' }).click();
    await page.getByRole('menuitem', { name: /^Forward/ }).click();
    await expect.poll(async () => (await viewerState(page)).page).toBe(4);
  });
});

test('screenshots: find and navigation in light and dark', async ({ page }) => {
  for (const theme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: theme });
    await openApp(page);
    await openFixture(page, 'multipage.pdf');
    await page.locator('.rail').getByRole('button', { name: 'Pages' }).click();
    await find(page, 'quokka');
    await page.keyboard.press('Control+g');
    await page.keyboard.press('Control+g');
    await page.waitForTimeout(300);
    await shot(page, `m3-find-${theme}`);
    await openFixture(page, 'outline.pdf');
    await page.locator('.rail').getByRole('button', { name: 'Bookmarks' }).click();
    await page.getByRole('searchbox', { name: 'Search bookmarks' }).fill('chap');
    await shot(page, `m3-bookmarks-${theme}`);
    await openFixture(page, 'page-labels.pdf');
    await page.locator('.rail').getByRole('button', { name: 'Pages' }).click();
    await page.waitForTimeout(400);
    await shot(page, `m3-labels-${theme}`);
    await page.evaluate(() => window.pdfEditor.storage.clearAll());
  }
});

test('highlights sit on the matched text (second match in a line)', async ({ page }) => {
  await openApp(page);
  await openFixture(page, 'multipage.pdf');
  await find(page, 'quokka');
  for (let i = 0; i < 3; i++) await page.keyboard.press('Control+g');
  await expect(counter(page)).toHaveText('4 of 4');
  await expect(pageIn(page, 9).locator('.textLayer .highlight')).toHaveCount(2);
  // Each highlight's box must be where its text is in the line: compare with
  // a Range over the same characters in an un-highlighted copy of the span.
  const result = await pageIn(page, 9).evaluate((el) => {
    const marks = [...el.querySelectorAll('.textLayer .highlight')];
    return marks.map((m) => {
      const parent = m.parentElement;
      const before = [...parent.childNodes].slice(0, [...parent.childNodes].indexOf(m)).map((n) => n.textContent).join('');
      const pr = parent.getBoundingClientRect();
      const r = m.getBoundingClientRect();
      // Expected x: proportional to character offset within the line (monospace-free estimate).
      return { text: m.textContent, offset: before.length, total: parent.textContent.length, relX: (r.left - pr.left) / pr.width, position: getComputedStyle(m).position };
    });
  });
  expect(result).toHaveLength(2);
  for (const r of result) {
    expect(r.position).not.toBe('absolute');
    expect(r.relX).toBeCloseTo(r.offset / r.total, 1);
  }
});
