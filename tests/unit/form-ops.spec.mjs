// Form ops in Node: fill, author, flatten and sign; read back with pdf.js and pdf-lib.
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import * as PDFLib from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { OPS, HELPERS } from '../../src/core/ops/index.js';

const fx = (name) => readFileSync(new URL(`../fixtures/${name}`, import.meta.url));
const ctx = { helpers: HELPERS };
const load = (bytes) => PDFLib.PDFDocument.load(bytes, { updateMetadata: false });
const save = (doc) => doc.save({ updateFieldAppearances: false });

async function readPdf(bytes) {
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes), verbosity: 0 });
  const pdf = await task.promise;
  const page = await pdf.getPage(1);
  const annots = await page.getAnnotations();
  const text = (await page.getTextContent()).items.map((i) => i.str).join(' ');
  const fields = await pdf.getFieldObjects();
  await task.destroy();
  return { annots, text, fields };
}

/** Decoded normal appearance of the first widget of a field (pdf-lib). */
function appearanceText(doc, name) {
  const field = doc.getForm().getField(name);
  const widget = field.acroField.getWidgets()[0];
  const ap = widget.getNormalAppearance();
  const stream = doc.context.lookup(ap);
  return new TextDecoder('latin1').decode(PDFLib.decodePDFRawStream(stream).decode());
}

test('fill every field kind; appearances are regenerated; pdf.js reads the values', async () => {
  const doc = await load(fx('forms.pdf'));
  const { affected } = await OPS.setFieldValues(PDFLib, doc, { values: [
    { name: 'full_name', value: 'Grace Hopper' },
    { name: 'notes', value: 'Line A\nLine B' },
    { name: 'subscribe', value: false },
    { name: 'plan', value: 'team' },
    { name: 'country', value: 'Japan' },
    { name: 'interests', value: ['Music', 'Poetry'] },
  ] }, ctx);
  expect(affected).toEqual([0]);
  const bytes = await save(doc);
  const re = await load(bytes);
  const hex = (str) => `<${Buffer.from(str, 'latin1').toString('hex').toUpperCase()}>`;
  expect(appearanceText(re, 'full_name')).toContain(hex('Grace Hopper'));
  expect(appearanceText(re, 'country')).toContain(hex('Japan'));
  const { annots } = await readPdf(bytes);
  const by = (n) => annots.filter((a) => a.fieldName === n);
  expect(by('full_name')[0].fieldValue).toBe('Grace Hopper');
  expect(by('notes')[0].fieldValue).toBe('Line A\nLine B');
  expect(by('subscribe')[0].fieldValue).toBe('Off');
  expect(by('plan')[0].fieldValue).toBe('team');
  expect(by('country')[0].fieldValue).toEqual(['Japan']);
  expect(by('interests')[0].fieldValue).toEqual(['Music', 'Poetry']);
});

test('author fields: add, properties, move, remove; field info', async () => {
  const doc = await load(fx('multipage.pdf'));
  const t = OPS.addField(PDFLib, doc, { page: 0, kind: 'text', rect: [100, 500, 300, 524] }, ctx).value;
  const c = OPS.addField(PDFLib, doc, { page: 0, kind: 'checkbox', rect: [100, 460, 116, 476] }, ctx).value;
  const d = OPS.addField(PDFLib, doc, { page: 0, kind: 'dropdown', rect: [100, 420, 260, 444], options: ['Red', 'Green'] }, ctx).value;
  const s = OPS.addField(PDFLib, doc, { page: 1, kind: 'signature', rect: [100, 100, 300, 150] }, ctx).value;
  expect([t.name, c.name, d.name, s.name]).toEqual(['Text 1', 'Checkbox 1', 'Dropdown 1', 'Signature 1']);
  expect(() => OPS.addField(PDFLib, doc, { page: 0, kind: 'text', rect: [0, 0, 10, 10], name: 'Text 1' }, ctx)).toThrow(/already exists/);

  OPS.setFieldProps(PDFLib, doc, { name: 'Text 1', newName: 'email', required: true, defaultValue: 'a@b.c' }, ctx);
  OPS.setFieldProps(PDFLib, doc, { name: 'Dropdown 1', options: ['Red', 'Green', 'Blue'], defaultValue: 'Blue' }, ctx);
  OPS.setFieldProps(PDFLib, doc, { name: 'Checkbox 1', defaultValue: true }, ctx);
  expect(() => OPS.setFieldProps(PDFLib, doc, { name: 'email', newName: 'a.b' }, ctx)).toThrow(/can’t contain/);
  const info = OPS.fieldInfo(PDFLib, doc, { name: 'email' }, ctx).value;
  expect(info).toMatchObject({ name: 'email', kind: 'text', required: true, defaultValue: 'a@b.c' });
  expect(OPS.fieldInfo(PDFLib, doc, { name: 'Dropdown 1' }, ctx).value.options).toEqual(['Red', 'Green', 'Blue']);
  OPS.setWidgetRect(PDFLib, doc, { id: t.id, rect: [150, 550, 400, 580] }, ctx);
  OPS.removeField(PDFLib, doc, { name: 'Checkbox 1' }, ctx);

  const bytes = await save(doc);
  const { annots, fields } = await readPdf(bytes);
  const email = annots.find((a) => a.fieldName === 'email');
  expect(email.fieldValue).toBe('a@b.c');
  expect(email.required).toBe(true);
  expect(email.rect.map(Math.round)).toEqual([150, 550, 400, 580]);
  expect(annots.find((a) => a.fieldName === 'Dropdown 1').fieldValue).toEqual(['Blue']);
  expect(annots.some((a) => a.fieldName === 'Checkbox 1')).toBe(false);
  expect(Object.keys(Object.fromEntries(fields ?? [])).sort()).toEqual(['Dropdown 1', 'Signature 1', 'email']);
  // No dangling widget refs left on the page.
  const re = await load(bytes);
  for (const ref of re.getPage(0).node.Annots().asArray()) expect(re.context.lookup(ref)).toBeTruthy();
});

test('flatten draws the values into the page and removes every field', async () => {
  const doc = await load(fx('forms.pdf'));
  await OPS.setFieldValues(PDFLib, doc, { values: [{ name: 'full_name', value: 'Flat Name' }] }, ctx);
  const { affected } = OPS.flattenForm(PDFLib, doc, {}, ctx);
  expect(affected).toEqual([0]);
  const { annots, text, fields } = await readPdf(await save(doc));
  expect(annots.filter((a) => a.subtype === 'Widget')).toHaveLength(0);
  expect(fields).toBeFalsy();
  expect(text).toContain('Flat Name');
  expect(text).toContain('France');
});

test('a visual signature is a stamp annotation with an image appearance', async () => {
  const doc = await load(fx('multipage.pdf'));
  // 2×1 red PNG.
  const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAEUlEQVR4nGP4z8DwHwQZYAwAWkEH+RHTSgAAAABJRU5ErkJggg==', 'base64'));
  const { value } = await OPS.addSignature(PDFLib, doc, { page: 0, rect: [100, 100, 300, 200], png, author: 'Ada' }, ctx);
  expect(value.id).toMatch(/^\d+R/);
  const { annots } = await readPdf(await save(doc));
  const stamp = annots.find((a) => a.subtype === 'Stamp');
  expect(stamp.hasAppearance).toBe(true);
  expect(stamp.titleObj.str).toBe('Ada');
  expect(stamp.contentsObj.str).toBe('Visual signature');
});
