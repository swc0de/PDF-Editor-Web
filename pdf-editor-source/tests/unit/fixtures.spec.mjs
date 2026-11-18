// Checks the generated fixtures really have the properties the e2e tests
// rely on, using pdf.js in Node (no browser).
import { test, expect } from '@playwright/test';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '../fixtures');
const manifest = JSON.parse(readFileSync(join(DIR, 'manifest.json'), 'utf8'));

function open(name, options = {}) {
  const data = new Uint8Array(readFileSync(join(DIR, name)));
  return pdfjs.getDocument({ data, verbosity: 0, isEvalSupported: false, ...options }).promise;
}

async function pageText(doc, n) {
  const content = await (await doc.getPage(n)).getTextContent();
  return content.items.map((i) => i.str).join(' ');
}

test('multipage: page count and search words', async () => {
  const doc = await open('multipage.pdf');
  expect(doc.numPages).toBe(12);
  let all = '';
  for (let i = 1; i <= doc.numPages; i++) all += ' ' + (await pageText(doc, i));
  expect(all.match(/quokka/gi)).toHaveLength(manifest['multipage.pdf'].search.quokka);
  expect(all.match(/Quokka/g)).toHaveLength(1);
});

test('mixed-sizes: every page has its own size and rotation', async () => {
  const doc = await open('mixed-sizes.pdf');
  const expected = manifest['mixed-sizes.pdf'].pages;
  expect(doc.numPages).toBe(expected.length);
  for (let i = 0; i < expected.length; i++) {
    const page = await doc.getPage(i + 1);
    const [x0, y0, x1, y1] = page.view;
    expect(x1 - x0).toBeCloseTo(expected[i].width, 1);
    expect(y1 - y0).toBeCloseTo(expected[i].height, 1);
    expect(page.rotate).toBe(expected[i].rotate);
  }
});

test('outline: nested tree with titles', async () => {
  const doc = await open('outline.pdf');
  const outline = await doc.getOutline();
  const titles = (items) => items.map((i) => [i.title, titles(i.items)]);
  const expected = (items) => items.map((i) => [i.title, expected(i.children ?? [])]);
  expect(titles(outline)).toEqual(expected(manifest['outline.pdf'].outline));
  const dest = outline[3].dest; // Appendix → page 10
  expect(await doc.getPageIndex(dest[0])).toBe(9);
});

test('page-labels: roman, decimal and prefixed labels', async () => {
  const doc = await open('page-labels.pdf');
  expect(await doc.getPageLabels()).toEqual(manifest['page-labels.pdf'].labels);
});

test('forms: every field type is present with its value', async () => {
  const doc = await open('forms.pdf');
  // pdf.js 6 returns a Map of field name → widget objects.
  const fields = Object.fromEntries(await doc.getFieldObjects());
  const expected = manifest['forms.pdf'].fields;
  expect(Object.keys(fields).sort()).toEqual(Object.keys(expected).sort());
  // pdf-lib writes a parent field + widget kids; the type is on the widgets.
  const widget = (k) => fields[k].find((o) => o.type);
  const types = Object.fromEntries(Object.keys(fields).map((k) => [k, widget(k).type]));
  expect(types).toMatchObject({
    full_name: 'text', notes: 'text', subscribe: 'checkbox', plan: 'radiobutton',
    country: 'combobox', interests: 'listbox', submit_button: 'button', signature: 'signature',
  });
  expect(widget('full_name').value).toBe('Ada Lovelace');
  expect(widget('country').value).toBe('France');
});

test('annotations: all subtypes are readable', async () => {
  const doc = await open('annotations.pdf');
  const annots = await (await doc.getPage(1)).getAnnotations();
  expect(annots.map((a) => a.subtype)).toEqual(manifest['annotations.pdf'].annotations);
  const links = annots.filter((a) => a.subtype === 'Link');
  expect(links.some((l) => l.url === 'https://example.com/')).toBe(true);
  expect(links.some((l) => Array.isArray(l.dest))).toBe(true);
});

test('attachment: two embedded files', async () => {
  const doc = await open('attachment.pdf');
  const files = await doc.getAttachments(); // a Map in pdf.js 6
  const names = [...files.values()].map((f) => f.filename).sort();
  expect(names).toEqual(['inner.pdf', 'notes.txt']);
});

test('layers: two optional content groups, one hidden by default', async () => {
  const doc = await open('layers.pdf');
  const config = await doc.getOptionalContentConfig();
  const groups = [...config].map(([, g]) => ({ name: g.name, visible: g.visible }));
  expect(groups).toEqual(manifest['layers.pdf'].layers);
});

test('corrupted: page 3 fails, the others load', async () => {
  const doc = await open('corrupted.pdf');
  expect(doc.numPages).toBe(5);
  for (const n of [1, 2, 4, 5]) await expect(doc.getPage(n)).resolves.toBeTruthy();
  await expect(doc.getPage(3)).rejects.toThrow();
});

test('truncated: cannot be opened at all (the app must explain, not go blank)', async () => {
  await expect(open('truncated.pdf')).rejects.toMatchObject({ name: 'InvalidPDFException' });
});

test('encrypted: needs the password', async () => {
  test.skip(!existsSync(join(DIR, 'encrypted.pdf')), 'no encryption tool when fixtures were generated');
  await expect(open('encrypted.pdf')).rejects.toMatchObject({ name: 'PasswordException' });
  const doc = await open('encrypted.pdf', { password: manifest['encrypted.pdf'].password });
  expect(doc.numPages).toBe(2);
});
