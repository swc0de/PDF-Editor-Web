// Combine / split jobs run in Node with the same pdf-lib + fflate.
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import * as PDFLib from 'pdf-lib';
import * as fflate from 'fflate';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { JOBS, HELPERS } from '../../src/core/ops/index.js';

const fx = (name) => new Uint8Array(readFileSync(new URL(`../fixtures/${name}`, import.meta.url)));
const ctx = {
  helpers: HELPERS,
  progress: () => {},
  zip: (files) => fflate.zipSync(Object.fromEntries(Object.entries(files).map(([n, b]) => [n, [b, { level: 0 }]]))),
};
const open = (bytes) => pdfjs.getDocument({ data: new Uint8Array(bytes), verbosity: 0 }).promise;
const titles = (items) => items.map((i) => [i.title, titles(i.items)]);
async function firstTexts(doc) {
  const out = [];
  for (let i = 1; i <= doc.numPages; i++) out.push((await (await doc.getPage(i)).getTextContent()).items[0]?.str ?? '');
  return out;
}

test('combine with a bookmark per file nests each source outline', async () => {
  const { bytes, pageCount } = await JOBS.combine(PDFLib, {
    files: [
      { name: 'multipage.pdf', bytes: fx('multipage.pdf'), pages: [0, 1] },
      { name: 'outline.pdf', bytes: fx('outline.pdf'), pages: null },
    ],
    bookmarks: true,
  }, ctx);
  expect(pageCount).toBe(12);
  const doc = await open(bytes);
  const outline = await doc.getOutline();
  expect(titles(outline)).toEqual([
    ['multipage', []],
    ['outline', [
      ['Introduction', []],
      ['Part One', [['Chapter 1', []], ['Chapter 2', [['Section 2.1', []]]]]],
      ['Part Two', [['Chapter 3', []]]],
      ['Appendix', []],
    ]],
  ]);
  // "outline" → first page of the second file; "Appendix" → its last page.
  expect(await doc.getPageIndex(outline[1].dest[0])).toBe(2);
  expect(await doc.getPageIndex(outline[1].items[3].dest[0])).toBe(11);
  const meta = await doc.getMetadata();
  expect(meta.info.Title).toBe('Multipage sample'); // from the first file
});

test('combine without file bookmarks keeps the sources’ outlines; partial ranges drop missing entries', async () => {
  const { bytes } = await JOBS.combine(PDFLib, {
    files: [{ name: 'outline.pdf', bytes: fx('outline.pdf'), pages: [0, 1, 2, 9] }],
    bookmarks: false,
  }, ctx);
  const doc = await open(bytes);
  // Part One keeps Chapter 1 (page 3 kept); Chapter 2 / Section 2.1 / Part Two / Chapter 3 are gone.
  expect(titles(await doc.getOutline())).toEqual([
    ['Introduction', []],
    ['Part One', [['Chapter 1', []]]],
    ['Appendix', []],
  ]);
});

test('combine carries form fields (renaming clashes) and internal links', async () => {
  const { bytes } = await JOBS.combine(PDFLib, {
    files: [
      { name: 'forms.pdf', bytes: fx('forms.pdf') },
      { name: 'forms.pdf', bytes: fx('forms.pdf') },
      { name: 'annotations.pdf', bytes: fx('annotations.pdf') },
    ],
    bookmarks: false,
  }, ctx);
  const doc = await open(bytes);
  const fields = await doc.getFieldObjects();
  expect(fields.size).toBe(16);
  expect(fields.has('full_name')).toBe(true);
  expect(fields.has('full_name_2')).toBe(true);
  const widget = fields.get('full_name_2').find((o) => o.type);
  expect(widget.value).toBe('Ada Lovelace');
  // The internal link on annotations.pdf page 1 (now page 3) → its page 2 (now page 4).
  const link = (await (await doc.getPage(3)).getAnnotations()).find((a) => a.subtype === 'Link' && a.dest);
  expect(await doc.getPageIndex(link.dest[0])).toBe(3);
});

test('split makes a zip of parts with their own outlines', async () => {
  const { zip, count } = await JOBS.split(PDFLib, {
    bytes: fx('outline.pdf'),
    parts: [
      { name: 'a.pdf', pages: [0] },
      { name: 'b.pdf', pages: [1, 2, 3, 4, 5] },
      { name: 'c.pdf', pages: [6, 7, 8, 9] },
    ],
  }, ctx);
  expect(count).toBe(3);
  const files = fflate.unzipSync(zip);
  expect(Object.keys(files)).toEqual(['a.pdf', 'b.pdf', 'c.pdf']);
  const b = await open(files['b.pdf']);
  expect(b.numPages).toBe(5);
  expect(await firstTexts(b)).toEqual(['Part One', 'Chapter 1', 'Page 4', 'Chapter 2', 'Section 2.1']);
  expect(titles(await b.getOutline())).toEqual([['Part One', [['Chapter 1', []], ['Chapter 2', [['Section 2.1', []]]]]]]);
});

test('split plans', async () => {
  const { planSplit, slug } = await import('../../src/core/split-plan.js');
  const names = (r) => r.parts.map((p) => p.name);
  const sizes = (r) => r.parts.map((p) => p.pages.length);
  expect(sizes(planSplit({ count: 12, base: 'doc', mode: 'every', every: 4 }))).toEqual([4, 4, 4]);
  expect(names(planSplit({ count: 10, base: 'doc', mode: 'every', every: 4 }))).toEqual([
    'doc-01-pages-1-4.pdf', 'doc-02-pages-5-8.pdf', 'doc-03-pages-9-10.pdf',
  ]);
  expect(sizes(planSplit({ count: 12, base: 'doc', mode: 'at', at: [4, 9] }))).toEqual([3, 5, 4]);
  expect(planSplit({ count: 12, base: 'doc', mode: 'at', at: [1, 13] })).toEqual({ error: 'at' });
  expect(planSplit({ count: 3, base: 'doc', mode: 'every', every: 5 })).toEqual({ error: 'oneFile' });
  const bm = planSplit({ count: 10, base: 'doc', mode: 'bookmarks', starts: [
    { page: 1, title: 'Part One' }, { page: 6, title: 'Part Two' }, { page: 9, title: 'Appendix' },
  ] });
  expect(names(bm)).toEqual(['doc-01-start.pdf', 'doc-02-part-one.pdf', 'doc-03-part-two.pdf', 'doc-04-appendix.pdf']);
  expect(sizes(bm)).toEqual([1, 5, 3, 1]);
  expect(slug('Chapter 2: Résumé?')).toBe('chapter-2-resume');
});
