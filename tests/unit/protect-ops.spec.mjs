// Redaction and sanitize ops in Node: nothing removed may survive anywhere in the saved file.
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import * as PDFLib from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { OPS, HELPERS } from '../../src/core/ops/index.js';

const fx = (name) => readFileSync(new URL(`../fixtures/${name}`, import.meta.url));
const ctx = { helpers: HELPERS };
const load = (bytes) => PDFLib.PDFDocument.load(bytes, { updateMetadata: false });
// A 1×1 JPEG (stands in for the rendered page image).
const JPG = Uint8Array.from(Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=', 'base64'));

async function read(bytes) {
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes), verbosity: 0 });
  const pdf = await task.promise;
  const pages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const p = await pdf.getPage(i);
    pages.push({ text: (await p.getTextContent()).items.map((it) => it.str).join(' '), annots: await p.getAnnotations() });
  }
  const meta = await pdf.getMetadata();
  const attachments = await pdf.getAttachments();
  const js = await pdf.getJSActions().catch(() => null);
  const oc = await pdf.getOptionalContentConfig();
  const groups = oc ? [...oc].map(([, g]) => g.name) : [];
  await task.destroy();
  return { pages, meta, attachments, js, groups };
}

/** Every stream in the file, decoded, as one latin1 string (what a forensic look would see). */
async function allStreams(bytes) {
  const doc = await load(bytes);
  let out = '';
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (obj instanceof PDFLib.PDFRawStream) {
      try {
        out += Buffer.from(PDFLib.decodePDFRawStream(obj).decode()).toString('latin1');
      } catch { /* image data */ }
    }
  }
  return out;
}
const hex = (s) => Buffer.from(s, 'latin1').toString('hex').toUpperCase();

test('sanitize: dry run counts; removal leaves no trace; links and visible content stay', async () => {
  const doc = await load(fx('sanitize.pdf'));
  const all = { metadata: true, javascript: true, attachments: true, hiddenLayers: true, comments: true };
  const scan = OPS.sanitize(PDFLib, doc, { ...all, dryRun: true }, ctx).value.counts;
  expect(scan.metadata).toBeGreaterThanOrEqual(5);
  expect(scan.javascript).toBe(4);
  expect(scan.attachments).toBe(1);
  expect(scan.hiddenLayers).toBe(1);
  expect(scan.comments).toBe(1);
  // The dry run changed nothing.
  const before = await read(await doc.save());
  expect(before.meta.info.Title).toBe('Sanitize sample');
  expect(before.pages[0].text).toContain('HIDDEN DRAFT TEXT');

  const { value } = OPS.sanitize(PDFLib, doc, all, ctx);
  expect(value.counts).toEqual(scan);
  const bytes = await doc.save();
  const after = await read(bytes);
  expect(after.meta.info.Title).toBeUndefined();
  expect(after.meta.info.Author).toBeUndefined();
  expect(after.meta.metadata).toBeFalsy();
  expect(after.attachments).toBeFalsy();
  expect(after.js).toBeFalsy();
  expect(after.groups).toEqual(['Shown']);
  expect(after.pages[0].text).toContain('SHOWN LAYER TEXT');
  expect(after.pages[0].text).not.toContain('HIDDEN DRAFT TEXT');
  const subtypes = after.pages[0].annots.map((a) => a.subtype);
  expect(subtypes).toEqual(['Link']); // the web link stays; the script link and the note go
  expect(after.pages[0].annots[0].url).toBe('https://example.com/');
  const streams = await allStreams(bytes);
  expect(streams).not.toContain('secret notes');
  expect(streams).not.toContain(hex('HIDDEN DRAFT TEXT'));
  expect(streams).not.toContain('Mallory');
  expect(Buffer.from(bytes).toString('latin1')).not.toContain('app.alert');
});

test('sanitize only what was asked', async () => {
  const doc = await load(fx('sanitize.pdf'));
  OPS.sanitize(PDFLib, doc, { comments: true }, ctx);
  const after = await read(await doc.save());
  expect(after.meta.info.Title).toBe('Sanitize sample');
  expect(after.attachments).toBeTruthy();
  expect(after.pages[0].annots.map((a) => a.subtype).sort()).toEqual(['Link', 'Link']);
});

test('apply redactions: page content replaced, marks and overlapping annotations gone, no trace left', async () => {
  const doc = await load(fx('multipage.pdf'));
  const top = [0, 396, 612, 792];
  OPS.addAnnotations(PDFLib, doc, { items: [
    { page: 0, spec: { type: 'redact', rect: top } },
    { page: 0, spec: { type: 'highlight', quads: [[56, 700, 300, 700, 56, 680, 300, 680]], color: '#ffd400', contents: 'Page 1 of 12' } },
    { page: 0, spec: { type: 'note', rect: [520, 100], contents: 'keep me' } },
  ] }, ctx);
  const marks = OPS.listRedactions(PDFLib, doc, {}, ctx).value;
  expect(marks).toHaveLength(1);
  expect(marks[0].rects[0].map(Math.round)).toEqual(top);
  const { affected } = await OPS.applyRedactions(PDFLib, doc, { pages: [{ page: 0, jpg: JPG, view: [0, 0, 612, 792], rects: marks[0].rects }] }, ctx);
  expect(affected).toEqual([0]);
  const bytes = await doc.save();
  const after = await read(bytes);
  expect(after.pages[0].text.trim()).toBe('');
  expect(after.pages[1].text).toContain('page-marker-02');
  expect(after.pages[0].annots.map((a) => a.subtype)).toEqual(['Text']);
  const streams = await allStreams(bytes);
  expect(streams).not.toContain(hex('page-marker-01'));
  expect(streams).not.toContain('Page 1 of 12');
  expect(streams).toContain(hex('page-marker-02'));
});

test('remove all redaction marks', async () => {
  const doc = await load(fx('multipage.pdf'));
  OPS.addAnnotations(PDFLib, doc, { items: [{ page: 0, spec: { type: 'redact', rect: [10, 10, 50, 50] } }, { page: 3, spec: { type: 'redact', quads: [[10, 60, 90, 60, 10, 40, 90, 40]] } }] }, ctx);
  const { affected, value } = OPS.removeRedactions(PDFLib, doc, {}, ctx);
  expect(value.removed).toBe(2);
  expect(affected.sort()).toEqual([0, 3]);
  expect(OPS.listRedactions(PDFLib, doc, {}, ctx).value).toEqual([]);
});
