import { test, expect, openApp, openFixture, viewerState } from './helpers.mjs';

// Main-thread stalls are measured with a heartbeat: a 10 ms interval timer
// records how late each tick fires. A tick that is N ms late means the main
// thread was blocked for about N ms. (The Long Tasks API isn't reported by
// headless Chromium, so we don't rely on it.)
const HEARTBEAT = () => {
  window.__stalls = [];
  let last = performance.now();
  setInterval(() => {
    const now = performance.now();
    const late = now - last - 10;
    if (late > 50) window.__stalls.push(Math.round(late));
    last = now;
  }, 10);
};

test('a 500-page PDF opens and scrolls without main-thread stalls over 200 ms', async ({ page }) => {
  test.setTimeout(60_000);
  await page.addInitScript(HEARTBEAT);
  await openApp(page);

  // Prove the detector works: a deliberate 120 ms busy loop must register.
  await page.evaluate(() => { const t = performance.now(); while (performance.now() - t < 120); });
  await expect.poll(() => page.evaluate(() => Math.max(0, ...window.__stalls))).toBeGreaterThan(100);
  await page.evaluate(() => { window.__stalls.length = 0; });

  const t0 = Date.now();
  await openFixture(page, 'large.pdf');
  const openMs = Date.now() - t0;
  await page.evaluate(() => window.pdfEditor.app.viewer.sizesLoaded);
  expect((await viewerState(page)).numPages).toBe(500);
  await expect(page.locator('.page')).toHaveCount(500);

  // Scroll through the whole document in 80 steps, like a fast reader.
  for (let i = 1; i <= 80; i++) {
    await page.evaluate((f) => {
      const v = document.querySelector('.viewer');
      v.scrollTop = f * (v.scrollHeight - v.clientHeight);
    }, i / 80);
    await page.waitForTimeout(40);
  }
  await expect.poll(async () => (await viewerState(page)).page).toBeGreaterThan(495);
  await expect(page.locator('.page[data-page-number="500"]')).toHaveAttribute('data-state', 'rendered');

  // Zoom while far down the document, then jump back to the top.
  await page.keyboard.press('Control+=');
  await page.keyboard.press('Control+=');
  await page.locator('.viewer').press('Home');
  await expect(page.locator('.page[data-page-number="1"]')).toHaveAttribute('data-state', 'rendered');
  await page.waitForTimeout(500);

  const stalls = await page.evaluate(() => window.__stalls);
  const worst = Math.max(0, ...stalls);
  console.log(`open: ${openMs} ms, stalls over 50 ms: ${stalls.length}, worst: ${worst} ms`);
  expect(worst).toBeLessThan(200);

  // Memory stays bounded: only pages near the viewport hold canvases.
  const canvases = await page.locator('.page canvas').count();
  expect(canvases).toBeLessThanOrEqual(20);
});

/** A ~50 MB PDF: pages carrying incompressible (noise) images. Built at test time, not committed. */
async function makeBigPdf(path) {
  const { PDFDocument } = await import('pdf-lib');
  const zlib = await import('node:zlib');
  const { writeFileSync } = await import('node:fs');
  const W = 1024;
  const H = 1024;
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const png = (seed) => {
    let x = seed;
    const raw = Buffer.alloc((W * 3 + 1) * H);
    for (let i = 0; i < raw.length; i++) {
      x = (x * 1664525 + 1013904223) >>> 0;
      raw[i] = i % (W * 3 + 1) === 0 ? 0 : x >>> 24;
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(W, 0);
    ihdr.writeUInt32BE(H, 4);
    ihdr[8] = 8;
    ihdr[9] = 2; // RGB
    return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 1 })), chunk('IEND', Buffer.alloc(0))]);
  };
  const doc = await PDFDocument.create();
  for (let i = 0; i < 17; i++) {
    const image = await doc.embedPng(png(i + 1));
    const page = doc.addPage([612, 792]);
    page.drawImage(image, { x: 36, y: 120, width: 540, height: 540 });
  }
  const bytes = await doc.save();
  writeFileSync(path, bytes);
  return bytes.length;
}

test('a 50 MB PDF opens and scrolls without long stalls; canvases stay bounded', async ({ page }) => {
  test.setTimeout(120_000);
  const path = test.info().outputPath('big.pdf');
  const size = await makeBigPdf(path);
  expect(size).toBeGreaterThan(50 * 1024 * 1024);
  await page.addInitScript(HEARTBEAT);
  await openApp(page);
  const t0 = Date.now();
  await page.evaluate(() => document.querySelectorAll('.viewer').forEach((v) => v.classList.add('stale-viewer')));
  await page.setInputFiles('#file-input', path);
  await page.waitForSelector('.viewer-host:not([hidden]) .viewer:not(.stale-viewer) .page[data-page-number="1"][data-state="rendered"]', { timeout: 60_000 });
  const openMs = Date.now() - t0;
  for (let i = 1; i <= 20; i++) {
    await page.evaluate((f) => {
      const v = document.querySelector('.viewer-host:not([hidden]) .viewer');
      v.scrollTop = f * (v.scrollHeight - v.clientHeight);
    }, i / 20);
    await page.waitForTimeout(150);
  }
  await expect(page.locator('.page[data-page-number="17"]')).toHaveAttribute('data-state', 'rendered', { timeout: 30_000 });
  await page.waitForTimeout(500);
  const stalls = await page.evaluate(() => window.__stalls);
  const worst = Math.max(0, ...stalls);
  console.log(`50 MB: ${(size / 1048576).toFixed(1)} MB, open ${openMs} ms, stalls over 50 ms: ${stalls.length}, worst: ${worst} ms`);
  expect(worst).toBeLessThan(400);
  expect(await page.locator('.page canvas').count()).toBeLessThanOrEqual(20);
});

test('opening and closing documents repeatedly doesn’t grow memory', async ({ page }) => {
  test.setTimeout(120_000);
  await openApp(page);
  const heap = () => page.evaluate(() => performance.memory?.usedJSHeapSize ?? 0);
  const cycle = async () => {
    await openFixture(page, 'multipage.pdf');
    await page.evaluate(() => window.pdfEditor.app.viewer.goToPage(6));
    await page.waitForTimeout(300);
    await page.keyboard.press('Control+w');
    await expect(page.locator('#home')).toBeVisible();
  };
  await cycle();
  await page.waitForTimeout(500);
  const base = await heap();
  for (let i = 0; i < 8; i++) await cycle();
  await page.waitForTimeout(1000);
  const after = await heap();
  const domCanvases = await page.locator('canvas').count();
  const workers = await page.evaluate(() => document.querySelectorAll('.viewer').length);
  console.log(`heap: ${(base / 1048576).toFixed(1)} MB → ${(after / 1048576).toFixed(1)} MB after 8 more open/close cycles; canvases: ${domCanvases}; viewers: ${workers}`);
  expect(workers).toBe(0);
  expect(domCanvases).toBe(0);
  if (base) expect(after - base).toBeLessThan(40 * 1048576);
});
