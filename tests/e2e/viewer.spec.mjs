import { test, expect, openApp, openFixture, viewerState, manifest, fixture, shot } from './helpers.mjs';

const pageEl = (page, n) => page.locator(`.viewer-host:not([hidden]) .page[data-page-number="${n}"]`);

/** Fraction of sampled canvas pixels that aren't white (proves something was drawn). */
async function inkRatio(page, n) {
  return page.evaluate((n) => {
    const canvas = document.querySelector(`.page[data-page-number="${n}"] .page-canvas`);
    if (!canvas || !canvas.width) return 0;
    const { data } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
    let ink = 0;
    let total = 0;
    for (let i = 0; i < data.length; i += 4 * 97) {
      total++;
      if (data[i] < 200 || data[i + 1] < 200 || data[i + 2] < 200) ink++;
    }
    return ink / total;
  }, n);
}

async function setZoom(page, value) {
  await page.evaluate((v) => window.pdfEditor.app.viewer.setZoom(v), value);
}

async function waitRendered(page, n) {
  await expect(pageEl(page, n)).toHaveAttribute('data-state', 'rendered');
}

test.describe('opening and rendering', () => {
  test('renders the first pages sharply and virtualizes the rest', async ({ page }) => {
    await openApp(page);
    await openFixture(page, 'multipage.pdf');
    await expect(page.locator('.page')).toHaveCount(12);
    await expect(page.locator('.statusbar .page-input')).toHaveValue('1');
    await expect(page.locator('.statusbar .page-total')).toHaveText('of 12');
    await expect(page.locator('.tab-item.active .tab-name')).toHaveText('multipage.pdf');
    await expect(page).toHaveTitle('multipage.pdf — PDF Editor');
    expect(await inkRatio(page, 1)).toBeGreaterThan(0.002);

    // Canvas resolution = CSS size × devicePixelRatio.
    const sharp = await page.evaluate(() => {
      const c = document.querySelector('.page[data-page-number="1"] .page-canvas');
      return { ratio: c.width / c.getBoundingClientRect().width, dpr: devicePixelRatio };
    });
    expect(sharp.ratio).toBeCloseTo(sharp.dpr, 1);

    // Only visible pages ±2 get canvases; far pages stay placeholders.
    await page.waitForTimeout(300);
    const rendered = await page.locator('.page[data-state="rendered"]').count();
    expect(rendered).toBeLessThanOrEqual(5);
    await expect(pageEl(page, 12)).toHaveAttribute('data-state', 'placeholder');
  });

  test('placeholders have each page’s real size (mixed sizes)', async ({ page }) => {
    await openApp(page);
    await openFixture(page, 'mixed-sizes.pdf');
    await page.evaluate(() => window.pdfEditor.app.viewer.sizesLoaded);
    const zoom = (await viewerState(page)).zoom;
    const boxes = await page.locator('.page').evaluateAll((els) =>
      els.map((el) => ({ w: el.offsetWidth, h: el.offsetHeight })));
    manifest['mixed-sizes.pdf'].pages.forEach((p, i) => {
      const turned = p.rotate % 180 !== 0;
      const w = (turned ? p.height : p.width) * zoom * (96 / 72);
      const h = (turned ? p.width : p.height) * zoom * (96 / 72);
      expect(Math.abs(boxes[i].w - w), `page ${i + 1} width`).toBeLessThanOrEqual(1);
      expect(Math.abs(boxes[i].h - h), `page ${i + 1} height`).toBeLessThanOrEqual(1);
    });
  });

  test('text layer allows selecting text', async ({ page }) => {
    await openApp(page);
    await openFixture(page, 'multipage.pdf');
    const layer = pageEl(page, 1).locator('.textLayer');
    await expect(layer).toContainText('Page 1 of 12');
    await expect(layer).toContainText('page-marker-01');
    const heading = layer.locator('span', { hasText: 'Page 1 of 12' }).first();
    await heading.dblclick();
    await heading.click({ clickCount: 3 });
    const selected = await page.evaluate(() => window.getSelection().toString());
    expect(selected).toContain('Page 1 of 12');
  });
});

test.describe('zoom', () => {
  test('keyboard zoom steps, actual size, typed zoom, fit width and fit page', async ({ page }) => {
    await openApp(page);
    await openFixture(page, 'multipage.pdf');
    const start = (await viewerState(page)).zoom;
    await page.keyboard.press('Control+=');
    expect((await viewerState(page)).zoom).toBeGreaterThan(start);
    await page.keyboard.press('Control+-');
    await page.keyboard.press('Control+-');
    expect((await viewerState(page)).zoom).toBeLessThan(start);
    await page.keyboard.press('Control+0');
    expect((await viewerState(page)).zoom).toBe(1);
    await expect(page.locator('.zoom-input')).toHaveValue('100%');

    const input = page.locator('.zoom-input');
    await input.fill('175');
    await input.press('Enter');
    expect((await viewerState(page)).zoom).toBe(1.75);

    await page.getByRole('button', { name: 'Fit width' }).click();
    const fit = await page.evaluate(() => {
      const v = document.querySelector('.viewer');
      return { page: document.querySelector('.page').offsetWidth, avail: v.clientWidth - 32 };
    });
    expect(Math.abs(fit.page - fit.avail)).toBeLessThanOrEqual(2);
    await expect(page.getByRole('button', { name: 'Fit width' })).toHaveAttribute('aria-pressed', 'true');

    await page.getByRole('button', { name: 'Fit page' }).click();
    const fp = await page.evaluate(() => ({
      page: document.querySelector('.page').offsetHeight,
      avail: document.querySelector('.viewer').clientHeight - 32,
    }));
    expect(fp.page).toBeLessThanOrEqual(fp.avail + 1);
    expect(fp.page).toBeGreaterThan(fp.avail - 3);
  });

  test('ctrl+wheel zoom keeps the point under the cursor still', async ({ page }) => {
    await openApp(page);
    await openFixture(page, 'multipage.pdf');
    // Zoomed in, so the page is wider than the viewport and can scroll both ways.
    await setZoom(page, 2);
    await page.evaluate(() => { const v = document.querySelector('.viewer'); v.scrollLeft = 200; v.scrollTop = 300; });
    const box = await page.locator('.viewer').boundingBox();
    const at = { x: 420, y: 300 };
    const anchor = () => page.evaluate((p) => window.pdfEditor.app.viewer.captureAnchor(p.x, p.y), at);
    const before = await anchor();
    await page.mouse.move(box.x + at.x, box.y + at.y);
    await page.keyboard.down('Control');
    await page.mouse.wheel(0, -120);
    await page.keyboard.up('Control');
    await expect.poll(async () => (await viewerState(page)).zoom).toBeGreaterThan(2);
    const after = await anchor();
    expect(after.idx).toBe(before.idx);
    expect(after.fx).toBeCloseTo(before.fx, 2);
    expect(after.fy).toBeCloseTo(before.fy, 2);
  });

  test('above 300% pages are drawn as tiles, only the visible ones', async ({ page }) => {
    await openApp(page);
    await openFixture(page, 'multipage.pdf');
    await setZoom(page, 4);
    const p1 = pageEl(page, 1);
    await expect(p1.locator('canvas.tile').first()).toBeAttached();
    await page.waitForTimeout(400);
    const info = await page.evaluate(() => {
      const el = document.querySelector('.page[data-page-number="1"]');
      const tiles = el.querySelectorAll('canvas.tile').length;
      const dpr = devicePixelRatio;
      const all = Math.ceil((el.offsetWidth * dpr) / 1024) * Math.ceil((el.offsetHeight * dpr) / 1024);
      const base = el.querySelector('.page-canvas');
      return { tiles, all, baseWidth: base?.width ?? 0, fullWidth: el.offsetWidth * dpr };
    });
    expect(info.tiles).toBeGreaterThan(0);
    expect(info.tiles).toBeLessThan(info.all);
    // The backdrop is low-resolution; sharpness comes from the tiles.
    expect(info.baseWidth).toBeLessThan(info.fullWidth / 2);
    // Back below 300%: tiles go away, a full canvas returns.
    await setZoom(page, 1);
    await expect(p1.locator('canvas.tile')).toHaveCount(0);
    await waitRendered(page, 1);
  });
});

test.describe('layouts and navigation', () => {
  test('page input, buttons and keys navigate', async ({ page }) => {
    await openApp(page);
    await openFixture(page, 'multipage.pdf');
    const input = page.locator('.page-input');
    await input.fill('7');
    await input.press('Enter');
    await expect.poll(async () => (await viewerState(page)).page).toBe(7);
    await waitRendered(page, 7);
    await expect(pageEl(page, 7).locator('.textLayer')).toContainText('Page 7 of 12');
    await page.getByRole('button', { name: 'Next page' }).click();
    await expect(input).toHaveValue('8');
    await page.getByRole('button', { name: 'Previous page' }).click();
    await expect(input).toHaveValue('7');
    await page.locator('.viewer').press('End');
    await expect(input).toHaveValue('12');
    await expect(page.getByRole('button', { name: 'Next page' })).toBeDisabled();
    await page.locator('.viewer').press('Home');
    await expect(input).toHaveValue('1');
    // Out-of-range input is rejected and restored.
    await input.fill('99');
    await input.press('Enter');
    await expect(input).toHaveValue('1');
  });

  test('single page, two-up, cover and rotation', async ({ page }) => {
    await openApp(page);
    await openFixture(page, 'multipage.pdf');
    const layoutBtn = page.locator('.layout-btn');

    await layoutBtn.click();
    await page.getByRole('menuitemradio', { name: 'Single page' }).click();
    await expect(page.locator('.page:not([hidden])')).toHaveCount(1);
    await expect(layoutBtn).toContainText('Single page');
    await page.locator('.viewer').press('PageDown');
    await expect(page.locator('.page:not([hidden])')).toHaveAttribute('data-page-number', '2');

    const tops = (...ns) => Promise.all(ns.map((n) => pageEl(page, n).evaluate((el) => el.offsetTop)));
    await layoutBtn.click();
    await page.getByRole('menuitemradio', { name: 'Two pages', exact: true }).click();
    await expect(page.locator('.page:not([hidden])')).toHaveCount(12);
    let [a, b, c] = await tops(1, 2, 3);
    expect(a).toBe(b);
    expect(c).toBeGreaterThan(a);

    await layoutBtn.click();
    await page.getByRole('menuitemradio', { name: 'Two pages with cover' }).click();
    [a, b, c] = await tops(1, 2, 3);
    expect(b).toBeGreaterThan(a);
    expect(b).toBe(c);

    await layoutBtn.click();
    await page.getByRole('menuitemradio', { name: 'Continuous' }).click();
    const before = await pageEl(page, 1).boundingBox();
    await layoutBtn.click();
    await page.getByRole('menuitem', { name: 'Rotate view right' }).click();
    expect((await viewerState(page)).rotation).toBe(90);
    await waitRendered(page, 1);
    const after = await pageEl(page, 1).boundingBox();
    expect(after.width / after.height).toBeCloseTo(before.height / before.width, 1);
    await expect(pageEl(page, 1).locator('.textLayer')).toHaveAttribute('data-main-rotation', '90');
    await layoutBtn.click();
    await page.getByRole('menuitem', { name: 'Rotate view left' }).click();
    expect((await viewerState(page)).rotation).toBe(0);
  });

  test('read mode hides the chrome; Esc exits. Full screen toggles.', async ({ page }) => {
    await openApp(page);
    await openFixture(page, 'multipage.pdf');
    await page.locator('.layout-btn').click();
    await page.getByRole('menuitem', { name: 'Read mode' }).click();
    await expect(page.locator('.topbar')).toBeHidden();
    await expect(page.locator('.statusbar')).toBeHidden();
    await expect(page.locator('.page').first()).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.topbar')).toBeVisible();
    await expect(page.locator('.statusbar')).toBeVisible();

    await page.locator('.layout-btn').click();
    await page.getByRole('menuitem', { name: 'Full screen' }).click();
    await expect.poll(() => page.evaluate(() => !!document.fullscreenElement)).toBe(true);
    await page.evaluate(() => document.exitFullscreen());
  });

  test('read mode is also available from the tools catalogue', async ({ page }) => {
    await openApp(page);
    await page.locator('.catalogue [data-tool="read-mode"]').click();
    await expect(page.locator('.toast')).toContainText('Open a PDF to use Read mode');
  });
});

test.describe('links', () => {
  test('internal links jump; external links ask first', async ({ page }) => {
    await openApp(page);
    await page.evaluate(() => {
      window.__opened = [];
      window.open = (...args) => { window.__opened.push(args); return null; };
    });
    await openFixture(page, 'annotations.pdf');
    await setZoom(page, 1);
    const links = pageEl(page, 1).locator('a.pdf-link');
    await expect(links).toHaveCount(2);

    await pageEl(page, 1).locator('a.pdf-link[data-dest]').click();
    await expect.poll(async () => (await viewerState(page)).page).toBe(2);

    await page.locator('.viewer').press('Home');
    await pageEl(page, 1).locator('a.pdf-link[data-url]').click();
    const dialog = page.getByRole('dialog', { name: 'Open external link?' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('https://example.com/');
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeHidden();
    expect(await page.evaluate(() => window.__opened.length)).toBe(0);

    await pageEl(page, 1).locator('a.pdf-link[data-url]').click();
    await page.getByRole('dialog').getByRole('button', { name: 'Open link' }).click();
    await expect.poll(() => page.evaluate(() => window.__opened))
      .toEqual([['https://example.com/', '_blank', 'noopener,noreferrer']]);
  });
});

test.describe('protected and damaged files', () => {
  test.skip(!manifest['encrypted.pdf'], 'no encrypted fixture');

  test('password prompt with retry', async ({ page }) => {
    await openApp(page);
    await openFixture(page, 'encrypted.pdf', { waitForRender: false });
    const dialog = page.getByRole('dialog', { name: 'Password required' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('encrypted.pdf');
    await dialog.getByLabel('Password').fill('wrong');
    await dialog.getByRole('button', { name: 'Open' }).click();
    const retry = page.getByRole('dialog', { name: 'Password required' });
    await expect(retry.getByRole('alert')).toHaveText('That password is incorrect. Try again.');
    await retry.getByLabel('Password').fill(manifest['encrypted.pdf'].password);
    await retry.getByRole('button', { name: 'Open' }).click();
    await waitRendered(page, 1);
    await expect(pageEl(page, 1).locator('.textLayer')).toContainText('Secret page 1');
  });

  test('cancelling the password prompt returns to home quietly', async ({ page }) => {
    await openApp(page);
    await openFixture(page, 'encrypted.pdf', { waitForRender: false });
    await page.getByRole('dialog', { name: 'Password required' }).getByRole('button', { name: 'Cancel' }).click();
    await expect(page.locator('#home')).toBeVisible();
    await expect(page.locator('.page')).toHaveCount(0);
  });
});

test.describe('damaged files', () => {
  test('working pages render; the broken page shows an error tile', async ({ page }) => {
    await openApp(page);
    await openFixture(page, 'corrupted.pdf');
    await setZoom(page, 0.25); // everything on screen at once
    for (const n of [1, 2, 4, 5]) await waitRendered(page, n);
    const broken = pageEl(page, 3);
    await expect(broken).toHaveAttribute('data-state', 'error');
    await expect(broken.getByRole('alert')).toContainText('Page 3 couldn’t be displayed');
    expect(await inkRatio(page, 5)).toBeGreaterThan(0);
  });

  test('an unopenable file shows an error and keeps the app usable', async ({ page }) => {
    await openApp(page);
    await openFixture(page, 'truncated.pdf', { waitForRender: false });
    const dialog = page.getByRole('dialog', { name: 'Can’t open “truncated.pdf”' });
    await expect(dialog).toContainText('isn’t a PDF, or it’s too damaged');
    await dialog.getByRole('button', { name: 'OK' }).click();
    await expect(page.locator('#home')).toBeVisible();
    await openFixture(page, 'multipage.pdf'); // still works afterwards
  });
});

test.describe('opening', () => {
  test('drag and drop opens a PDF', async ({ page }) => {
    await openApp(page);
    const bytes = [...(await import('node:fs')).readFileSync(fixture('outline.pdf'))];
    await page.evaluate((bytes) => {
      const dt = new DataTransfer();
      dt.items.add(new File([new Uint8Array(bytes)], 'dropped.pdf', { type: 'application/pdf' }));
      const fire = (type) => window.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }));
      fire('dragenter');
      fire('dragover');
      fire('drop');
    }, bytes);
    await waitRendered(page, 1);
    await expect(page.locator('.tab-item.active .tab-name')).toHaveText('dropped.pdf');
    await expect(page.locator('.drop-overlay')).toBeHidden();
  });

  test('Ctrl+O opens the file picker; closing returns home', async ({ page }) => {
    await openApp(page);
    // (Playwright's filechooser event races its own interception setup under
    // load, so assert that the shortcut opens the picker input instead.)
    await page.evaluate(() => {
      window.__pickerOpened = 0;
      document.getElementById('file-input').addEventListener('click', (e) => {
        e.preventDefault();
        window.__pickerOpened++;
      });
    });
    await page.keyboard.press('Control+o');
    await expect.poll(() => page.evaluate(() => window.__pickerOpened)).toBe(1);
    await page.locator('#topbar-open').click();
    await expect.poll(() => page.evaluate(() => window.__pickerOpened)).toBe(2);
    await openFixture(page, 'multipage.pdf');
    await waitRendered(page, 1);
    await page.getByRole('button', { name: 'Close multipage.pdf' }).click();
    await expect(page.locator('#home')).toBeVisible();
    await expect(page.locator('.statusbar')).toHaveCount(0);
    await expect(page).toHaveTitle('PDF Editor');
  });
});

test('screenshots: viewer in light and dark', async ({ page }) => {
  for (const theme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: theme });
    await openApp(page);
    await openFixture(page, 'mixed-sizes.pdf');
    await setZoom(page, 0.5);
    await page.waitForTimeout(400);
    await shot(page, `m1-viewer-${theme}`);
    await page.locator('.layout-btn').click();
    await shot(page, `m1-layout-menu-${theme}`);
    await page.keyboard.press('Escape');
    await openFixture(page, 'corrupted.pdf');
    await setZoom(page, 0.4);
    await page.evaluate(() => window.pdfEditor.app.viewer.goToPage(2, { fy: 0.6 }));
    await page.waitForTimeout(400);
    await shot(page, `m1-corrupted-${theme}`);
    if (manifest['encrypted.pdf']) {
      await openFixture(page, 'encrypted.pdf', { waitForRender: false });
      await page.getByRole('dialog').getByLabel('Password').fill('nope');
      await page.getByRole('dialog').getByRole('button', { name: 'Open' }).click();
      await expect(page.getByRole('dialog').getByRole('alert')).toBeVisible();
      await shot(page, `m1-password-${theme}`);
      await page.keyboard.press('Escape');
    }
  }
});
