// The page operations run in the worker; here they run in Node against the
// fixtures (same pdf-lib), checked with pdf.js.
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import * as PDFLib from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { OPS } from '../../src/core/ops/index.js';
import { parsePageRange, formatPageRange } from '../../src/core/page-range.js';

const fx = (name) => readFileSync(new URL(`../fixtures/${name}`, import.meta.url));

async function run(name, op, args) {
  const doc = await PDFLib.PDFDocument.load(fx(name), { updateMetadata: false });
  const result = await OPS[op](PDFLib, doc, args);
  return { bytes: await doc.save(), result };
}

async function headings(bytes) {
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), verbosity: 0 }).promise;
  const out = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const tc = await (await doc.getPage(i)).getTextContent();
    out.push(tc.items[0]?.str ?? '');
  }
  return { doc, out };
}

const titles = (items) => items.map((i) => [i.title, titles(i.items)]);

test('reorderPages keeps the page objects, so bookmarks follow their pages', async () => {
  const { bytes } = await run('outline.pdf', 'reorderPages', { order: [2, 0, 1, 3, 4, 5, 6, 7, 8, 9] });
  const { doc, out } = await headings(bytes);
  expect(out.slice(0, 3)).toEqual(['Chapter 1', 'Introduction', 'Part One']);
  const outline = await doc.getOutline();
  const chapter1 = outline[1].items[0];
  expect(chapter1.title).toBe('Chapter 1');
  expect(await doc.getPageIndex(chapter1.dest[0])).toBe(0);
});

test('deletePages removes bookmarks that pointed at deleted pages', async () => {
  // Delete page 10 (Appendix) and page 6 (Section 2.1).
  const { bytes } = await run('outline.pdf', 'deletePages', { pages: [9, 5] });
  const { doc, out } = await headings(bytes);
  expect(out).toHaveLength(8);
  expect(out).not.toContain('Appendix');
  expect(titles(await doc.getOutline())).toEqual([
    ['Introduction', []],
    ['Part One', [['Chapter 1', []], ['Chapter 2', []]]],
    ['Part Two', [['Chapter 3', []]]],
  ]);
});

test('deletePages refuses to delete every page', async () => {
  await expect(run('outline.pdf', 'deletePages', { pages: [...Array(10).keys()] })).rejects.toThrow(/at least one page/);
});

test('deletePages drops form fields that only lived on deleted pages', async () => {
  // forms.pdf has one page: add a second page first, then delete page 1.
  const doc = await PDFLib.PDFDocument.load(fx('forms.pdf'), { updateMetadata: false });
  doc.addPage();
  await OPS.deletePages(PDFLib, doc, { pages: [0] });
  const re = await PDFLib.PDFDocument.load(await doc.save());
  expect(re.getForm().getFields()).toHaveLength(0);
});

test('duplicatePages puts each copy after its original', async () => {
  const { bytes } = await run('multipage.pdf', 'duplicatePages', { pages: [0, 2] });
  const { out } = await headings(bytes);
  expect(out.slice(0, 6)).toEqual(['Page 1 of 12', 'Page 1 of 12', 'Page 2 of 12', 'Page 3 of 12', 'Page 3 of 12', 'Page 4 of 12']);
  expect(out).toHaveLength(14);
});

test('insertBlank and insertFromPdf', async () => {
  const blank = await run('multipage.pdf', 'insertBlank', { at: 1, size: [595.28, 841.89] });
  const b = await headings(blank.bytes);
  expect(b.out[1]).toBe('');
  const [, , w, h] = (await b.doc.getPage(2)).view;
  expect([Math.round(w), Math.round(h)]).toEqual([595, 842]);

  const ins = await run('multipage.pdf', 'insertFromPdf', { at: 12, bytes: fx('outline.pdf'), pages: [0, 2] });
  expect(ins.result.value.inserted).toBe(2);
  const i = await headings(ins.bytes);
  expect(i.out.slice(11)).toEqual(['Page 12 of 12', 'Introduction', 'Chapter 1']);
});

test('page ranges', () => {
  expect(parsePageRange('1-3, 7, 10-', 12)).toEqual({ pages: [0, 1, 2, 6, 9, 10, 11] });
  expect(parsePageRange('', 3)).toEqual({ pages: [0, 1, 2] });
  expect(parsePageRange('-2', 5)).toEqual({ pages: [0, 1] });
  expect(parsePageRange('3-1', 5)).toEqual({ pages: [2, 1, 0] });
  expect(parsePageRange('2, 2', 5)).toEqual({ pages: [1] });
  expect(parsePageRange('0', 5)).toEqual({ error: '0' });
  expect(parsePageRange('9', 5)).toEqual({ error: '9' });
  expect(parsePageRange('a', 5)).toEqual({ error: 'a' });
  expect(formatPageRange([0, 1, 2, 6, 9, 10])).toBe('1-3, 7, 10-11');
});

test('ops in sequence on one document see the current pages (pdf-lib cache)', async () => {
  // The worker keeps one pdf-lib document across edits, as here.
  const doc = await PDFLib.PDFDocument.load(fx('multipage.pdf'), { updateMetadata: false });
  await OPS.deletePages(PDFLib, doc, { pages: [1, 3] });
  await OPS.duplicatePages(PDFLib, doc, { pages: [0, 1] });
  const { out } = await headings(await doc.save());
  expect(out.slice(0, 5)).toEqual(['Page 1 of 12', 'Page 1 of 12', 'Page 3 of 12', 'Page 3 of 12', 'Page 5 of 12']);
});
