// OCR text layer op: invisible, positioned, searchable; a second run replaces the first.
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import * as PDFLib from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { OPS, HELPERS } from '../../src/core/ops/index.js';

const fx = (name) => readFileSync(new URL(`../fixtures/${name}`, import.meta.url));
const ctx = { helpers: HELPERS };

async function textItems(bytes) {
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes), verbosity: 0 });
  const pdf = await task.promise;
  const items = (await (await pdf.getPage(1)).getTextContent()).items.filter((i) => i.str.trim());
  await task.destroy();
  return items;
}

test('addTextLayer writes invisible words where they were recognized; re-running replaces them', async () => {
  const doc = await PDFLib.PDFDocument.load(fx('scanned.pdf'), { updateMetadata: false });
  const words = [
    { text: 'capybara', x: 100, y: 600, dx: 1, dy: 0, w: 90, size: 14 },
    { text: 'rotated', x: 300, y: 300, dx: 0, dy: 1, w: 60, size: 12 },
    { text: 'naïve€', x: 100, y: 500, dx: 1, dy: 0, w: 60, size: 12 },
    { text: 'ελλάδα', x: 100, y: 450, dx: 1, dy: 0, w: 60, size: 12 },
  ];
  const { value, affected } = await OPS.addTextLayer(PDFLib, doc, { pages: [{ page: 0, words }] }, ctx);
  expect(value.words).toBe(4);
  expect(affected).toEqual([0]);
  let items = await textItems(await doc.save());
  const cap = items.find((i) => i.str.includes('capybara'));
  expect(cap.transform[4]).toBeCloseTo(100, 0);
  expect(cap.transform[5]).toBeCloseTo(600, 0);
  expect(cap.width).toBeGreaterThan(85);
  expect(cap.width).toBeLessThan(100);
  expect(items.map((i) => i.str).join(' ')).toContain('naïve€'); // WinAnsi characters survive
  expect(items.map((i) => i.str).join(' ')).toContain('??????'); // others become "?"
  // Render mode 3 (invisible).
  const page = doc.getPage(0);
  const contents = page.node.Contents().asArray().map((r) => doc.context.lookup(r));
  const ocr = contents.filter((s) => s.dict.get(PDFLib.PDFName.of('PDFEditorOCR')));
  expect(ocr).toHaveLength(3); // q, Q and the text layer
  // Again: replaced, not added.
  await OPS.addTextLayer(PDFLib, doc, { pages: [{ page: 0, words: [{ text: 'quetzal', x: 100, y: 600, dx: 1, dy: 0, w: 80, size: 14 }] }] }, ctx);
  items = await textItems(await doc.save());
  expect(items.map((i) => i.str).join(' ')).not.toContain('capybara');
  expect(items.map((i) => i.str).join(' ')).toContain('quetzal');
});
