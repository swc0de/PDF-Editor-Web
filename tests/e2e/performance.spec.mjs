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
