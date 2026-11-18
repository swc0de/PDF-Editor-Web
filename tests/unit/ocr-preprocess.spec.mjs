// OCR preprocessing (pure pixel functions).
import { test, expect } from '@playwright/test';
import { toGray, median3, otsu, estimateSkew } from '../../src/core/ocr-preprocess.js';

/** A white W×H image with dark "text lines" tilted by `deg` (lines run down to the right for positive deg). */
function lines(W, H, deg) {
  const g = new Uint8ClampedArray(W * H).fill(245);
  const t = Math.tan((deg * Math.PI) / 180);
  for (let row = 0; row < 12; row++) {
    const y0 = 80 + row * 60;
    for (let x = 60; x < W - 60; x++) {
      if ((x >> 4) % 3 === 2) continue; // gaps between "words"
      const y = Math.round(y0 + x * t);
      for (let dy = 0; dy < 12; dy++) if (y + dy < H) g[(y + dy) * W + x] = 20;
    }
  }
  return g;
}

test('gray, median and Otsu', () => {
  const rgba = new Uint8ClampedArray([255, 0, 0, 255, 0, 0, 0, 0, 10, 10, 10, 255, 200, 200, 200, 255]);
  expect([...toGray(rgba, 4, 1)]).toEqual([76, 255, 10, 200]);
  const g = new Uint8ClampedArray(25).fill(200);
  g[12] = 0; // a single speck
  expect(median3(g, 5, 5)[12]).toBe(200);
  const two = new Uint8ClampedArray(100);
  two.fill(30, 0, 40);
  two.fill(220, 40);
  const t = otsu(two);
  expect(t).toBeGreaterThanOrEqual(30);
  expect(t).toBeLessThan(220);
});

test('skew estimate finds the angle of tilted lines', () => {
  for (const deg of [0, 2, -3, 4.5]) {
    const g = lines(1000, 900, deg);
    expect(estimateSkew(g, 1000, 900, otsu(g))).toBeCloseTo(deg, 0);
  }
});
