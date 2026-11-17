import { test, expect, openApp, openFixture, viewerState, pageIn, shot, reloadApp } from './helpers.mjs';

const tabs = (page) => page.getByRole('tab');
const activeTab = (page) => page.locator('[role="tab"][aria-selected="true"]');
const app = (page, fn, arg) => page.evaluate(fn, arg);

test.describe('tabs', () => {
  test('each tab keeps its own zoom, page, layout and selection', async ({ page }) => {
    await openApp(page);
    await openFixture(page, 'multipage.pdf');
    await openFixture(page, 'outline.pdf');
    await expect(tabs(page)).toHaveCount(2);
    await expect(activeTab(page)).toHaveText('outline.pdf');

    // Tab 2: zoom 200%, page 6, two-up.
    await app(page, () => {
      const v = window.pdfEditor.app.viewer;
      v.setZoom(2);
      v.setMode('two-up');
      v.goToPage(6);
    });
    const tab2 = await viewerState(page);

    // Tab 1: select the heading text.
    await tabs(page).filter({ hasText: 'multipage.pdf' }).click();
    await expect(activeTab(page)).toHaveText('multipage.pdf');
    const heading = pageIn(page, 1).locator('.textLayer span', { hasText: 'Page 1 of 12' }).first();
    await heading.click({ clickCount: 3 });
    const selected = await page.evaluate(() => window.getSelection().toString());
    expect(selected).toContain('Page 1 of 12');
    const tab1 = await viewerState(page);
    expect(tab1.mode).toBe('continuous');

    // Back to tab 2: everything as it was.
    await tabs(page).filter({ hasText: 'outline.pdf' }).click();
    const again = await viewerState(page);
    expect(again.zoom).toBe(2);
    expect(again.mode).toBe('two-up');
    expect(again.page).toBe(tab2.page);

    // And tab 1 still has its selection.
    await tabs(page).filter({ hasText: 'multipage.pdf' }).click();
    expect(await page.evaluate(() => window.getSelection().toString())).toBe(selected);
    expect((await viewerState(page)).zoom).toBe(tab1.zoom);
  });

  test('close, close others, reopen closed tab (with its view), Ctrl+W', async ({ page }) => {
    await openApp(page);
    await openFixture(page, 'multipage.pdf');
    await openFixture(page, 'outline.pdf');
    await openFixture(page, 'page-labels.pdf');
    await expect(tabs(page)).toHaveCount(3);

    // Close outline.pdf with its × after moving it to page 7.
    await tabs(page).filter({ hasText: 'outline.pdf' }).click();
    await app(page, () => window.pdfEditor.app.viewer.goToPage(7));
    await page.getByRole('button', { name: 'Close outline.pdf' }).click();
    await expect(tabs(page)).toHaveCount(2);

    // Reopen it: same page comes back.
    await page.keyboard.press('Control+Shift+T');
    await expect(tabs(page)).toHaveCount(3);
    await expect(activeTab(page)).toHaveText('outline.pdf');
    await expect.poll(async () => (await viewerState(page)).page).toBe(7);

    // Right-click → Close others.
    await tabs(page).filter({ hasText: 'multipage.pdf' }).click({ button: 'right' });
    const menu = page.getByRole('menu');
    await expect(menu.getByRole('menuitem')).toHaveText([/^Close\s*Ctrl\+W$/, 'Close others', /^Reopen closed tab/]);
    await menu.getByRole('menuitem', { name: 'Close others' }).click();
    await expect(tabs(page)).toHaveCount(1);
    await expect(activeTab(page)).toHaveText('multipage.pdf');

    // Ctrl+W closes the active tab and shows Home.
    await page.keyboard.press('Control+w');
    await expect(tabs(page)).toHaveCount(0);
    await expect(page.locator('#home')).toBeVisible();
    await expect(page.locator('.statusbar')).toHaveCount(0);

    // The context menu offers reopening.
    await page.keyboard.press('Control+Shift+T');
    await expect(activeTab(page)).toHaveText('multipage.pdf');
  });

  test('unsaved dot and close guard', async ({ page }) => {
    await openApp(page);
    await openFixture(page, 'multipage.pdf');
    await app(page, () => window.pdfEditor.app.rotateCurrentPage(90));
    await expect(page.locator('.tab-item.active .tab-dirty')).toBeVisible();
    await page.getByRole('button', { name: 'Close multipage.pdf' }).click();
    const dialog = page.getByRole('dialog', { name: 'Save changes to “multipage.pdf”?' });
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(tabs(page)).toHaveCount(1);
    await page.getByRole('button', { name: 'Close multipage.pdf' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Don’t save' }).click();
    await expect(tabs(page)).toHaveCount(0);
  });

  test('opening the same file again switches to its tab; Home button; arrow keys', async ({ page }) => {
    await openApp(page);
    await openFixture(page, 'multipage.pdf');
    await openFixture(page, 'outline.pdf');
    await page.setInputFiles('#file-input', (await import('./helpers.mjs')).fixture('multipage.pdf'));
    await expect(activeTab(page)).toHaveText('multipage.pdf');
    await expect(tabs(page)).toHaveCount(2);

    await page.getByRole('button', { name: 'Home' }).click();
    await expect(page.locator('#home')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Home' })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('[role="tab"][aria-selected="true"]')).toHaveCount(0);

    await tabs(page).first().focus();
    await page.keyboard.press('ArrowRight');
    await expect(activeTab(page)).toHaveText('outline.pdf');
    await expect(activeTab(page)).toBeFocused();
  });

  test('the tab strip scrolls horizontally with the wheel', async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 700 });
    await openApp(page);
    for (const f of ['multipage.pdf', 'outline.pdf', 'page-labels.pdf', 'forms.pdf', 'annotations.pdf', 'layers.pdf', 'mixed-sizes.pdf']) {
      await openFixture(page, f);
    }
    const scroller = page.locator('.tab-scroller');
    await scroller.evaluate((el) => { el.scrollLeft = 0; });
    expect(await scroller.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
    await scroller.hover();
    await page.mouse.wheel(0, 200);
    await expect.poll(() => scroller.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);
  });
});

test.describe('panels', () => {
  test('side panel: F4, rail buttons, empty states, resizing', async ({ page }) => {
    await openApp(page);
    const side = page.locator('#side-panel');
    await expect(side).toBeHidden();
    await page.keyboard.press('F4');
    await expect(side).toBeVisible();
    await expect(side.locator('.side-panel-title')).toHaveText('Pages');
    await expect(side).toContainText('No document open');

    await openFixture(page, 'multipage.pdf');
    await expect(side.locator('.thumb').first()).toBeVisible(); // Pages panel is built (M3)

    for (const [name, title] of [['Layers', 'Layers'], ['Fields', 'Fields'], ['Comments', 'Comments'], ['Attachments', 'Attachments'], ['Document Properties', 'Document Properties']]) {
      const btn = page.locator('.rail').getByRole('button', { name, exact: true });
      await btn.click();
      await expect(btn).toHaveAttribute('aria-pressed', 'true');
      await expect(side.locator('.side-panel-title')).toHaveText(title);
      await expect(side.locator('.empty-state')).toBeVisible();
      await expect(side.locator('.empty-state')).toContainText('Coming soon');
    }
    // Clicking the active rail button closes the panel.
    await page.locator('.rail').getByRole('button', { name: 'Document Properties' }).click();
    await expect(side).toBeHidden();
    await page.keyboard.press('F4');
    await expect(side).toBeVisible();

    // Drag the inner edge: wider, clamped to 520.
    const splitter = page.locator('.side-splitter');
    const box = await splitter.boundingBox();
    await page.mouse.move(box.x + 2, box.y + 200);
    await page.mouse.down();
    await page.mouse.move(box.x - 100, box.y + 200, { steps: 4 });
    await page.mouse.up();
    const w1 = await side.evaluate((el) => el.offsetWidth);
    expect(w1).toBeGreaterThan(400);
    expect(w1).toBeLessThanOrEqual(520);
    await page.mouse.move(box.x - 100 + 2, box.y + 200);
    await page.mouse.down();
    await page.mouse.move(box.x - 600, box.y + 200, { steps: 4 });
    await page.mouse.up();
    expect(await side.evaluate((el) => el.offsetWidth)).toBe(520);

    // Keyboard resizing on the separator.
    await splitter.focus();
    await page.keyboard.press('ArrowRight');
    expect(await side.evaluate((el) => el.offsetWidth)).toBe(504);
    await page.keyboard.press('Home');
    expect(await side.evaluate((el) => el.offsetWidth)).toBe(260);
    await expect(splitter).toHaveAttribute('aria-valuenow', '260');
  });

  test('tools panel: Shift+F4, filter, resizing; arrangement persists and resets', async ({ page }) => {
    await openApp(page);
    const tools = page.locator('#tools-panel');
    await expect(tools).toBeVisible();
    await expect(tools.locator('.tools-group-title')).toHaveText(['Read', 'Find', 'Organize', 'Combine & split', 'Protect', 'Forms & layers', 'Scan & OCR', 'Everywhere']);
    await expect(tools.locator('.tool-row[data-tool="read-mode"] .badge')).toHaveCount(0);
    await expect(tools.locator('.tool-row[data-tool="ocr"] .badge')).toHaveText('Coming soon');

    await tools.getByRole('searchbox').fill('page');
    await expect(tools.locator('.tool-row').first()).toBeVisible();
    expect(await tools.locator('.tool-row').count()).toBeLessThan(10);
    await tools.getByRole('searchbox').fill('');

    const splitter = page.locator('.tools-splitter');
    const box = await splitter.boundingBox();
    await page.mouse.move(box.x + 2, box.y + 300);
    await page.mouse.down();
    await page.mouse.move(box.x - 200, box.y + 300, { steps: 4 });
    await page.mouse.up();
    expect(await tools.evaluate((el) => el.offsetWidth)).toBe(240);
    const box2 = await splitter.boundingBox();
    await page.mouse.move(box2.x + 2, box2.y + 300);
    await page.mouse.down();
    await page.mouse.move(box2.x + 120, box2.y + 300, { steps: 4 });
    await page.mouse.up();
    const width = await tools.evaluate((el) => el.offsetWidth);
    expect(width).toBeGreaterThan(300);

    await page.keyboard.press('F4');
    await page.keyboard.press('Shift+F4');
    await expect(tools).toBeHidden();

    await reloadApp(page);
    await expect(tools).toBeHidden();
    await expect(page.locator('#side-panel')).toBeVisible();
    await page.keyboard.press('Shift+F4');
    expect(await tools.evaluate((el) => el.offsetWidth)).toBe(width);

    await page.getByRole('menuitem', { name: 'View' }).click();
    await page.getByRole('menuitem', { name: 'Reset arrangement' }).click();
    await expect(tools).toBeVisible();
    expect(await tools.evaluate((el) => el.offsetWidth)).toBe(260);
    await expect(page.locator('#side-panel')).toBeHidden();
  });

  test('read mode also hides the panels', async ({ page }) => {
    await openApp(page);
    await openFixture(page, 'multipage.pdf');
    await page.keyboard.press('F4');
    await page.locator('.tool-row[data-tool="read-mode"]').click();
    await expect(page.locator('#tools-panel')).toBeHidden();
    await expect(page.locator('#side-panel')).toBeHidden();
    await expect(page.locator('.rail')).toBeHidden();
    await page.keyboard.press('Escape');
    await expect(page.locator('#side-panel')).toBeVisible();
  });
});

test.describe('command palette', () => {
  test('fuzzy search by label and id, arrow keys, Enter runs, recent first', async ({ page }) => {
    await openApp(page);
    await openFixture(page, 'multipage.pdf');
    const startZoom = (await viewerState(page)).zoom;

    await page.keyboard.press('Control+k');
    const palette = page.getByRole('dialog', { name: 'Command palette' });
    const input = palette.getByRole('combobox');
    await expect(input).toBeFocused();
    await input.fill('zoom in');
    const options = palette.getByRole('option');
    await expect(options.first()).toContainText('Zoom in');
    await expect(options.first()).toHaveAttribute('aria-selected', 'true');
    await expect(options.first().locator('kbd')).toHaveText('Ctrl+=');
    await input.press('Enter');
    await expect(palette).toBeHidden();
    expect((await viewerState(page)).zoom).toBeGreaterThan(startZoom);

    // Fuzzy: "rtrgt" finds "Rotate view right"; ids match too.
    await page.keyboard.press('Control+k');
    await input.fill('rotvr');
    await expect(options.first()).toContainText('Rotate view right');
    await input.fill('view.fitPage');
    await expect(options.first()).toContainText('Fit page');

    // Tools are listed, unbuilt ones marked.
    await input.fill('redact');
    await expect(options.first()).toContainText('Redact');
    await expect(options.first()).toContainText('Coming soon');

    // Arrow keys move the active option.
    await input.fill('zoom');
    await input.press('ArrowDown');
    await expect(options.nth(1)).toHaveAttribute('aria-selected', 'true');
    await expect(input).toHaveAttribute('aria-activedescendant', 'palette-opt-1');
    await input.press('Escape');
    await expect(palette).toBeHidden();

    // Recently used commands come first with an empty query.
    await page.keyboard.press('Control+k');
    await expect(options.first()).toContainText('Zoom in');
    await expect(options.first()).toContainText('Recent');
    await input.press('Escape');
  });

  test('the palette button opens it too, and tools run from it', async ({ page }) => {
    await openApp(page);
    await page.locator('#palette-button').click();
    const input = page.getByRole('combobox');
    await input.fill('preferences');
    await input.press('Enter');
    await expect(page.getByRole('dialog', { name: 'Preferences' })).toBeVisible();
  });
});

test.describe('preferences', () => {
  test('saved in localStorage and applied', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await openApp(page);
    await page.keyboard.press('Control+,');
    const dialog = page.getByRole('dialog', { name: 'Preferences' });
    await dialog.getByLabel('Theme').selectOption('dark');
    await dialog.getByRole('radio', { name: 'Right' }).check();
    await dialog.getByLabel('Your name').fill('Ada Lovelace');
    await dialog.getByLabel('Default zoom').selectOption('1');
    await dialog.getByLabel('Default page layout').selectOption('two-up');
    await dialog.getByRole('button', { name: 'Save' }).click();

    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(page.locator('.workspace')).toHaveAttribute('data-tools-side', 'right');
    const toolsX = (await page.locator('#tools-panel').boundingBox()).x;
    expect(toolsX).toBeGreaterThan(600);

    await reloadApp(page);
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(page.locator('.workspace')).toHaveAttribute('data-tools-side', 'right');
    await openFixture(page, 'multipage.pdf');
    const s = await viewerState(page);
    expect(s.zoom).toBe(1);
    expect(s.mode).toBe('two-up');

    await page.keyboard.press('Control+,');
    await expect(dialog.getByLabel('Your name')).toHaveValue('Ada Lovelace');
    await expect(dialog.getByLabel('Theme')).toHaveValue('dark');
    // "Match system" follows the OS again.
    await dialog.getByLabel('Theme').selectOption('system');
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  });
});

test.describe('recent files', () => {
  test('remembered across reloads, opened with one click, removable', async ({ page }) => {
    await openApp(page);
    await expect(page.locator('.recents')).toContainText('Files you open will appear here.');
    await openFixture(page, 'multipage.pdf');
    await openFixture(page, 'outline.pdf');
    // Thumbnail is generated in the background.
    await page.getByRole('button', { name: 'Home' }).click();
    const cards = page.locator('.recent');
    await expect(cards).toHaveCount(2);
    await expect(cards.first()).toContainText('outline.pdf');
    await expect(cards.filter({ hasText: 'multipage.pdf' })).toContainText('12 pages');
    await expect(cards.first().locator('img.recent-thumb')).toBeVisible();

    await reloadApp(page);
    await expect(cards).toHaveCount(2);
    await cards.filter({ hasText: 'multipage.pdf' }).locator('.recent-open').click();
    await expect(activeTab(page)).toHaveText('multipage.pdf');
    await expect(pageIn(page, 1)).toHaveAttribute('data-state', 'rendered');

    await page.getByRole('button', { name: 'Home' }).click();
    await expect(cards.first()).toContainText('multipage.pdf'); // most recent first
    await page.getByRole('button', { name: 'Remove outline.pdf from recent files' }).click();
    await expect(cards).toHaveCount(1);
    await reloadApp(page);
    await expect(cards).toHaveCount(1);

    await page.getByRole('button', { name: 'Clear recent files' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Clear recent files' }).click();
    await expect(cards).toHaveCount(0);
  });
});

test.describe('menus and help', () => {
  test('menu bar is keyboard navigable and shows shortcuts', async ({ page }) => {
    await openApp(page);
    const file = page.getByRole('menuitem', { name: 'File' });
    await file.focus();
    await page.keyboard.press('ArrowDown');
    const menu = page.getByRole('menu', { name: 'File' });
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: /Open…/ })).toBeFocused();
    await expect(menu.getByRole('menuitem', { name: /Open…/ }).locator('.menu-shortcut')).toHaveText('Ctrl+O');
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('menu', { name: 'Edit' })).toBeVisible();
    await page.keyboard.press('ArrowRight');
    const view = page.getByRole('menu', { name: 'View' });
    await expect(view).toBeVisible();
    await expect(view.getByRole('menuitemcheckbox', { name: /Tools panel/ })).toHaveAttribute('aria-checked', 'true');
    await page.keyboard.press('Escape');
    await expect(view).toBeHidden();
    await expect(page.getByRole('menuitem', { name: 'View' })).toBeFocused();
    await page.keyboard.press('ArrowLeft');
    await expect(page.getByRole('menuitem', { name: 'Edit' })).toBeFocused();
  });

  test('Help → About shows version, licenses and credit', async ({ page }) => {
    await openApp(page);
    await page.getByRole('menuitem', { name: 'Help' }).click();
    await page.getByRole('menuitem', { name: 'About PDF Editor' }).click();
    const about = page.getByRole('dialog', { name: 'PDF Editor' });
    await expect(about).toContainText(/Version \d+\.\d+\.\d+/);
    for (const lib of ['pdfjs-dist', 'pdf-lib', 'fflate', 'tesseract.js']) await expect(about).toContainText(lib);
    await expect(about).toContainText('Apache-2.0');
    await expect(about).toContainText('MIT');
    await expect(about).toContainText('Inspired by the open-source PdfCraft project (MIT/Apache-2.0).');
    await about.getByRole('button', { name: 'Close' }).click();
    await expect(about).toBeHidden();

    await page.keyboard.press('Control+/');
    await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toContainText('Command palette');
  });
});

test('screenshots: shell in light and dark', async ({ page }) => {
  for (const theme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: theme });
    await openApp(page);
    await openFixture(page, 'multipage.pdf');
    await openFixture(page, 'mixed-sizes.pdf');
    await page.getByRole('button', { name: 'Home' }).click();
    await expect(page.locator('.recent img').first()).toBeVisible();
    await shot(page, `m2-home-${theme}`);
    await page.locator('.tab').first().click();
    await page.keyboard.press('F4');
    await page.locator('.rail').getByRole('button', { name: 'Bookmarks' }).click();
    await shot(page, `m2-document-${theme}`);
    await page.getByRole('menuitem', { name: 'View' }).click();
    await shot(page, `m2-menu-${theme}`);
    await page.keyboard.press('Escape');
    await page.keyboard.press('Control+k');
    await page.getByRole('combobox').fill('zo');
    await shot(page, `m2-palette-${theme}`);
    await page.keyboard.press('Escape');
    await page.keyboard.press('Control+,');
    await shot(page, `m2-prefs-${theme}`);
    await page.keyboard.press('Escape');
    await page.getByRole('menuitem', { name: 'Help' }).click();
    await page.getByRole('menuitem', { name: 'About PDF Editor' }).click();
    await shot(page, `m2-about-${theme}`);
    await page.keyboard.press('Escape');
    await page.evaluate(() => window.pdfEditor.storage.clearAll());
  }
});
