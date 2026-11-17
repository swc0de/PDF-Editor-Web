// Annotation ops in Node: write each type, read back with pdf.js and pdf-lib.
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import * as PDFLib from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { OPS, HELPERS } from '../../src/core/ops/index.js';

const fx = (name) => readFileSync(new URL(`../fixtures/${name}`, import.meta.url));
const ctx = { helpers: HELPERS };
const SPECS = [
  { type: 'highlight', quads: [[56, 664, 230, 664, 56, 646, 230, 646]], color: '#ffd400', opacity: 0.5 },
  { type: 'underline', quads: [[56, 640, 200, 640, 56, 626, 200, 626]], color: '#0050c8' },
  { type: 'strikeout', quads: [[56, 620, 200, 620, 56, 606, 200, 606]], color: '#b70228' },
  { type: 'square', rect: [60, 400, 200, 500], color: '#b70228', width: 2, opacity: 0.8 },
  { type: 'circle', rect: [240, 400, 380, 500], color: '#0050c8', width: 3 },
  { type: 'line', line: [400, 400, 550, 500], arrow: true, color: '#00803c', width: 2 },
  { type: 'ink', ink: [[60, 300, 100, 350, 140, 310]], color: '#7a00a0', width: 3 },
  { type: 'freetext', rect: [300, 300, 520, 340], text: 'Hello box\nSecond line', fontSize: 14, color: '#000000' },
  { type: 'note', rect: [520, 700], contents: 'A note', color: '#ffd400' },
];

test('every annotation type is written with an appearance and reads back in pdf.js', async () => {
  const doc = await PDFLib.PDFDocument.load(fx('multipage.pdf'), { updateMetadata: false });
  const { value, affected } = OPS.addAnnotations(PDFLib, doc, { items: SPECS.map((spec) => ({ page: 0, spec: { ...spec, author: 'Ada' } })) }, ctx);
  expect(value.ids).toHaveLength(SPECS.length);
  expect(affected).toEqual([0]);
  const bytes = await doc.save();

  // pdf-lib: every annotation has an /AP /N stream.
  const re = await PDFLib.PDFDocument.load(bytes);
  const annots = re.getPage(0).node.Annots().asArray().map((r) => re.context.lookup(r));
  for (const a of annots) {
    const ap = a.lookup(PDFLib.PDFName.of('AP'));
    expect(ap?.get(PDFLib.PDFName.of('N'))).toBeTruthy();
  }

  const pdf = await pdfjs.getDocument({ data: new Uint8Array(bytes), verbosity: 0 }).promise;
  const read = await (await pdf.getPage(1)).getAnnotations();
  expect(read.map((a) => a.subtype)).toEqual(['Highlight', 'Underline', 'StrikeOut', 'Square', 'Circle', 'Line', 'Ink', 'FreeText', 'Text']);
  for (const a of read) expect(a.titleObj.str).toBe('Ada');
  expect(read.find((a) => a.subtype === 'Text').contentsObj.str).toBe('A note');
  expect(read.find((a) => a.subtype === 'FreeText').contentsObj.str).toBe('Hello box\nSecond line');
  expect(read.find((a) => a.subtype === 'Square').hasAppearance).toBe(true);
  expect(Array.from(read.find((a) => a.subtype === 'Circle').color)).toEqual([0, 80, 200]);
  expect(read.find((a) => a.subtype === 'Line').lineCoordinates).toEqual([400, 400, 550, 500]);
});

test('move/resize transforms geometry; replies, states and delete', async () => {
  const doc = await PDFLib.PDFDocument.load(fx('annotations.pdf'), { updateMetadata: false });
  const before = await pdfjs.getDocument({ data: new Uint8Array(fx('annotations.pdf')), verbosity: 0 }).promise;
  const annots = await (await before.getPage(1)).getAnnotations();
  const line = annots.find((a) => a.subtype === 'Line');
  const square = annots.find((a) => a.subtype === 'Square');
  const note = annots.find((a) => a.subtype === 'Text');

  // Move the line by (+10, -20): Rect and L both shift.
  const r = line.rect;
  OPS.updateAnnotation(PDFLib, doc, { page: 0, id: line.id, from: r, rect: [r[0] + 10, r[1] - 20, r[2] + 10, r[3] - 20] }, ctx);
  OPS.updateAnnotation(PDFLib, doc, { page: 0, id: square.id, color: '#00ff00', width: 5, contents: 'Edited' }, ctx);
  const reply = OPS.addReply(PDFLib, doc, { page: 0, parent: note.id, contents: 'A reply', author: 'Bob' }, ctx).value.id;
  OPS.setReviewState(PDFLib, doc, { page: 0, parent: note.id, state: 'Completed', author: 'Bob' }, ctx);

  let pdf = await pdfjs.getDocument({ data: new Uint8Array(await doc.save()), verbosity: 0 }).promise;
  let read = await (await pdf.getPage(1)).getAnnotations();
  const l2 = read.find((a) => a.subtype === 'Line');
  expect(l2.lineCoordinates).toEqual([line.lineCoordinates[0] + 10, line.lineCoordinates[1] - 20, line.lineCoordinates[2] + 10, line.lineCoordinates[3] - 20]);
  const s2 = read.find((a) => a.id === square.id);
  expect(s2.contentsObj.str).toBe('Edited');
  expect(Array.from(s2.color)).toEqual([0, 255, 0]);
  expect(s2.hasAppearance).toBe(true);
  const children = read.filter((a) => a.inReplyTo === note.id);
  expect(children.map((a) => [a.contentsObj.str, a.state])).toEqual([['A reply', null], ['Completed set by Bob', 'Completed']]);
  expect(children[0].id).toBe(reply);

  // Deleting the note removes its reply and state too.
  OPS.deleteAnnotations(PDFLib, doc, { page: 0, ids: [note.id] }, ctx);
  pdf = await pdfjs.getDocument({ data: new Uint8Array(await doc.save()), verbosity: 0 }).promise;
  read = await (await pdf.getPage(1)).getAnnotations();
  expect(read.filter((a) => a.subtype === 'Text')).toHaveLength(0);
  expect(read).toHaveLength(annots.length - 1);
});

test('text boxes: wrapped text, Word-style formatting, box grows to fit, style round-trips', async () => {
  const doc = await PDFLib.PDFDocument.load(fx('multipage.pdf'), { updateMetadata: false });
  const text = 'The quick brown fox jumps over the lazy dog, again and again, until it wraps.';
  const { value } = OPS.addAnnotations(PDFLib, doc, { items: [{ page: 0, spec: {
    type: 'freetext', rect: [100, 600, 250, 620], text, fontSize: 12, color: '#0050c8',
    fontFamily: 'Courier', bold: true, italic: true, underline: true, align: 'right', fill: '#fff3a3', border: '#1e2327', borderWidth: 2,
  } }] }, ctx);
  const id = value.ids[0];
  const spec = OPS.annotationSpec(PDFLib, doc, { page: 0, id }, ctx).value;
  expect(spec).toMatchObject({ type: 'freetext', text, fontFamily: 'Courier', bold: true, italic: true, underline: true, align: 'right', fill: '#fff3a3', border: '#1e2327', borderWidth: 2, color: '#0050c8' });
  // 150 pt wide at 12 pt Courier: several lines, so the box grew downwards from its top edge.
  expect(spec.rect[3]).toBe(620);
  expect(spec.rect[3] - spec.rect[1]).toBeGreaterThan(12 * 1.2 * 3);
  const dict = doc.context.lookup(HELPERS.refFromId(PDFLib, id));
  const ap = dict.lookup(PDFLib.PDFName.of('AP')).lookup(PDFLib.PDFName.of('N'));
  const content = new TextDecoder('latin1').decode(ap.getContents());
  expect(content).toContain('/CoBO 12 Tf');
  expect(content.match(/ Tj/g).length).toBeGreaterThanOrEqual(3);
  expect(String(dict.get(PDFLib.PDFName.of('DA')))).toContain('/CoBO 12 Tf');
  expect(dict.lookup(PDFLib.PDFName.of('Q')).asNumber()).toBe(2);
  // Restyle and re-text: still one annotation, new font, wider box needs fewer lines.
  OPS.updateAnnotation(PDFLib, doc, { page: 0, id, contents: 'Short', fontFamily: 'Times', bold: false, rect: [100, 500, 400, 520], from: spec.rect }, ctx);
  const after = OPS.annotationSpec(PDFLib, doc, { page: 0, id }, ctx).value;
  expect(after).toMatchObject({ text: 'Short', fontFamily: 'Times', bold: false, italic: true });
  const bytes = await doc.save();
  const pdf = await pdfjs.getDocument({ data: bytes, verbosity: 0 }).promise;
  const annots = await (await pdf.getPage(1)).getAnnotations();
  const ft = annots.find((a) => a.subtype === 'FreeText');
  expect(ft.hasAppearance).toBe(true);
  expect(ft.contentsObj.str).toBe('Short');
});

