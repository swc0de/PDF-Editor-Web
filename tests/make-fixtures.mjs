#!/usr/bin/env node
// Generates the test fixture PDFs in tests/fixtures/ with pdf-lib.
// Output is deterministic (fixed dates, no random ids) so re-running it
// doesn't churn git. Facts the tests rely on are written to manifest.json.
//
//   node tests/make-fixtures.mjs
//
// The password-protected fixture needs an encryption tool: the qpdf CLI if
// it's installed, otherwise Python's pikepdf (which bundles qpdf). If neither
// is available that one fixture is skipped (and its tests skip too).

import { writeFile, mkdir, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PDFDocument,
  PDFName,
  PDFString,
  PDFHexString,
  PDFOperator,
  StandardFonts,
  rgb,
  degrees,
} from 'pdf-lib';

const DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const FIXED_DATE = new Date('2024-01-15T10:30:00Z');
const PASSWORD = 'secret';
const OWNER_PASSWORD = 'owner-secret';

const SIZES = {
  letter: [612, 792],
  a4: [595.28, 841.89],
  a5: [419.53, 595.28],
  legal: [612, 1008],
};

const manifest = {};

// ---------------------------------------------------------------- helpers

async function newDoc(title) {
  const doc = await PDFDocument.create();
  doc.setTitle(title);
  doc.setAuthor('PDF Editor test suite');
  doc.setSubject('Test fixture');
  doc.setKeywords(['fixture', 'test']);
  doc.setProducer('pdf-lib (tests/make-fixtures.mjs)');
  doc.setCreator('PDF Editor fixtures');
  doc.setCreationDate(FIXED_DATE);
  doc.setModificationDate(FIXED_DATE);
  return doc;
}

async function save(doc, name, info = {}) {
  const bytes = await doc.save({ useObjectStreams: false, updateFieldAppearances: true });
  await writeFile(join(DIR, name), bytes);
  manifest[name] = { pageCount: doc.getPageCount(), ...info };
  console.log(`  ${name.padEnd(22)} ${String(doc.getPageCount()).padStart(3)} pages  ${(bytes.length / 1024).toFixed(1)} KB`);
  return bytes;
}

function heading(page, font, text, y = page.getHeight() - 72) {
  page.drawText(text, { x: 56, y, size: 22, font, color: rgb(0.12, 0.14, 0.16) });
}

function paragraph(page, font, text, y, size = 11) {
  const maxWidth = page.getWidth() - 112;
  const words = text.split(/\s+/);
  let line = '';
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(next, size) > maxWidth) {
      page.drawText(line, { x: 56, y, size, font });
      y -= size * 1.5;
      line = word;
    } else {
      line = next;
    }
  }
  if (line) page.drawText(line, { x: 56, y, size, font });
  return y - size * 2;
}

const LOREM =
  'The quick brown fox jumps over the lazy dog. Pack my box with five dozen liquor jugs. ' +
  'How vexingly quick daft zebras jump. Sphinx of black quartz, judge my vow. ' +
  'A wizard’s job is to vex chumps quickly in fog.';

const str = (s) => PDFString.of(s);
const name = (s) => PDFName.of(s);

// ------------------------------------------------------------ multipage.pdf
// 12 Letter pages with known searchable words:
//   "quokka" — page 2 ×1, page 5 ×1, page 9 ×2  → 4 matches (case-insensitive)
//   "Quokka" — page 9 ×1 of the above (for match-case tests)
async function multipage() {
  const doc = await newDoc('Multipage sample');
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  for (let i = 1; i <= 12; i++) {
    const page = doc.addPage(SIZES.letter);
    heading(page, bold, `Page ${i} of 12`);
    let y = paragraph(page, font, LOREM, page.getHeight() - 120);
    if (i === 2) y = paragraph(page, font, 'A quokka is a small marsupial.', y);
    if (i === 5) y = paragraph(page, font, 'Have you ever seen a quokka smile?', y);
    if (i === 9) {
      y = paragraph(page, font, 'Quokka facts: the quokka lives on Rottnest Island.', y);
    }
    paragraph(page, font, `Unique marker: page-marker-${String(i).padStart(2, '0')}`, y);
    // footer
    page.drawText(String(i), { x: page.getWidth() / 2 - 4, y: 30, size: 10, font });
  }
  await save(doc, 'multipage.pdf', {
    search: { quokka: 4, quokkaMatchCase: { Quokka: 1, quokka: 3 } },
    pageSize: SIZES.letter,
  });
}

// ---------------------------------------------------------- mixed-sizes.pdf
async function mixedSizes() {
  const doc = await newDoc('Mixed page sizes');
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const pages = [
    { label: 'A4 portrait', size: SIZES.a4 },
    { label: 'Letter portrait', size: SIZES.letter },
    { label: 'A5 landscape', size: [SIZES.a5[1], SIZES.a5[0]] },
    { label: 'Legal portrait', size: SIZES.legal },
    { label: 'Square 400×400', size: [400, 400] },
    { label: 'Letter with /Rotate 90', size: SIZES.letter, rotate: 90 },
  ];
  for (const p of pages) {
    const page = doc.addPage(p.size);
    if (p.rotate) page.setRotation(degrees(p.rotate));
    page.drawRectangle({
      x: 10, y: 10, width: p.size[0] - 20, height: p.size[1] - 20,
      borderColor: rgb(0.72, 0.01, 0.16), borderWidth: 2,
    });
    page.drawText(p.label, { x: 30, y: p.size[1] - 50, size: 18, font });
  }
  await save(doc, 'mixed-sizes.pdf', {
    pages: pages.map((p) => ({ label: p.label, width: p.size[0], height: p.size[1], rotate: p.rotate ?? 0 })),
  });
}

// -------------------------------------------------------------- outline.pdf
// Outline tree (the "Part" entries have nested children):
//   Introduction → p1
//   Part One → p2  [Chapter 1 → p3, Chapter 2 → p5 [Section 2.1 → p6]]
//   Part Two → p7  [Chapter 3 → p8]
//   Appendix → p10
function addOutline(doc, items) {
  const ctx = doc.context;
  const pageRefs = doc.getPages().map((p) => p.ref);
  const rootRef = ctx.nextRef();

  const build = (nodes, parentRef) => {
    const refs = nodes.map(() => ctx.nextRef());
    let total = 0;
    nodes.forEach((node, i) => {
      const dict = {
        Title: PDFHexString.fromText(node.title),
        Parent: parentRef,
        Dest: [pageRefs[node.page - 1], name('XYZ'), null, null, null],
      };
      if (i > 0) dict.Prev = refs[i - 1];
      if (i < nodes.length - 1) dict.Next = refs[i + 1];
      if (node.children?.length) {
        const child = build(node.children, refs[i]);
        dict.First = child.first;
        dict.Last = child.last;
        dict.Count = node.open ? child.count : -child.count;
        total += node.open ? child.count : 0;
      }
      ctx.assign(refs[i], ctx.obj(dict));
      total += 1;
    });
    return { first: refs[0], last: refs.at(-1), count: total };
  };

  const top = build(items, rootRef);
  ctx.assign(rootRef, ctx.obj({ Type: 'Outlines', First: top.first, Last: top.last, Count: top.count }));
  doc.catalog.set(name('Outlines'), rootRef);
  doc.catalog.set(name('PageMode'), name('UseOutlines'));
}

const OUTLINE = [
  { title: 'Introduction', page: 1 },
  {
    title: 'Part One', page: 2, open: true,
    children: [
      { title: 'Chapter 1', page: 3 },
      { title: 'Chapter 2', page: 5, children: [{ title: 'Section 2.1', page: 6 }] },
    ],
  },
  { title: 'Part Two', page: 7, children: [{ title: 'Chapter 3', page: 8 }] },
  { title: 'Appendix', page: 10 },
];

async function outline() {
  const doc = await newDoc('Document with an outline');
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const titles = {};
  const walk = (nodes) => nodes.forEach((n) => { titles[n.page] = n.title; walk(n.children ?? []); });
  walk(OUTLINE);
  for (let i = 1; i <= 10; i++) {
    const page = doc.addPage(SIZES.a4);
    heading(page, bold, titles[i] ?? `Page ${i}`);
    paragraph(page, font, LOREM, page.getHeight() - 120);
  }
  addOutline(doc, OUTLINE);
  await save(doc, 'outline.pdf', { outline: OUTLINE });
}

// ---------------------------------------------------------- page-labels.pdf
// 10 pages labelled i, ii, iii, iv, 1, 2, 3, 4, A-1, A-2
async function pageLabels() {
  const doc = await newDoc('Document with page labels');
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const labels = ['i', 'ii', 'iii', 'iv', '1', '2', '3', '4', 'A-1', 'A-2'];
  labels.forEach((label, i) => {
    const page = doc.addPage(SIZES.letter);
    heading(page, font, `Page index ${i + 1}, label "${label}"`);
  });
  const ctx = doc.context;
  doc.catalog.set(
    name('PageLabels'),
    ctx.obj({
      Nums: [
        0, ctx.obj({ S: 'r' }),
        4, ctx.obj({ S: 'D' }),
        8, ctx.obj({ S: 'D', P: str('A-'), St: 1 }),
      ],
    }),
  );
  await save(doc, 'page-labels.pdf', { labels });
}

// ---------------------------------------------------------------- forms.pdf
async function forms() {
  const doc = await newDoc('AcroForm with every field type');
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage(SIZES.letter);
  const form = doc.getForm();
  heading(page, font, 'Application form');
  const label = (text, y) => page.drawText(text, { x: 56, y: y + 6, size: 11, font });

  label('Full name', 640);
  const nameField = form.createTextField('full_name');
  nameField.setText('Ada Lovelace');
  nameField.addToPage(page, { x: 200, y: 636, width: 300, height: 22, font });

  label('Notes', 560);
  const notes = form.createTextField('notes');
  notes.enableMultiline();
  notes.setText('First line\nSecond line');
  notes.addToPage(page, { x: 200, y: 540, width: 300, height: 70, font });

  label('Subscribe', 500);
  const subscribe = form.createCheckBox('subscribe');
  subscribe.addToPage(page, { x: 200, y: 500, width: 16, height: 16 });
  subscribe.check();

  label('Plan', 460);
  const plan = form.createRadioGroup('plan');
  ['basic', 'pro', 'team'].forEach((opt, i) => {
    plan.addOptionToPage(opt, page, { x: 200 + i * 80, y: 460, width: 16, height: 16 });
    page.drawText(opt, { x: 222 + i * 80, y: 464, size: 10, font });
  });
  plan.select('pro');

  label('Country', 410);
  const country = form.createDropdown('country');
  country.addOptions(['Australia', 'Canada', 'France', 'Japan']);
  country.select('France');
  country.addToPage(page, { x: 200, y: 404, width: 200, height: 22, font });

  label('Interests', 340);
  const interests = form.createOptionList('interests');
  interests.addOptions(['Maths', 'Music', 'Poetry', 'Engines']);
  interests.enableMultiselect();
  interests.select(['Maths', 'Engines']);
  interests.addToPage(page, { x: 200, y: 290, width: 200, height: 70, font });

  const button = form.createButton('submit_button');
  button.addToPage('Submit', page, { x: 200, y: 240, width: 100, height: 26, font });

  // Signature field (pdf-lib has no creation API for these).
  label('Signature', 180);
  const ctx = doc.context;
  const sigRef = ctx.register(
    ctx.obj({
      FT: 'Sig', T: str('signature'), Type: 'Annot', Subtype: 'Widget',
      Rect: [200, 170, 420, 210], F: 4, P: page.ref, MK: { BC: [0.5, 0.5, 0.5] },
    }),
  );
  page.node.addAnnot(sigRef);
  form.acroForm.addField(sigRef);

  await save(doc, 'forms.pdf', {
    fields: {
      full_name: { type: 'text', value: 'Ada Lovelace' },
      notes: { type: 'text', multiline: true, value: 'First line\nSecond line' },
      subscribe: { type: 'checkbox', value: true },
      plan: { type: 'radio', value: 'pro', options: ['basic', 'pro', 'team'] },
      country: { type: 'dropdown', value: 'France' },
      interests: { type: 'listbox', value: ['Maths', 'Engines'] },
      submit_button: { type: 'button' },
      signature: { type: 'signature' },
    },
  });
}

// ---------------------------------------------------------- annotations.pdf
async function annotations() {
  const doc = await newDoc('Annotations of common types');
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page1 = doc.addPage(SIZES.letter);
  const page2 = doc.addPage(SIZES.letter);
  heading(page1, font, 'Annotated page');
  page1.drawText('This sentence is highlighted.', { x: 56, y: 650, size: 14, font });
  page1.drawText('Go to page 2', { x: 56, y: 120, size: 12, font, color: rgb(0, 0.2, 0.7) });
  page1.drawText('Visit example.com', { x: 300, y: 120, size: 12, font, color: rgb(0, 0.2, 0.7) });
  heading(page2, font, 'Link target');

  const ctx = doc.context;
  const common = (subtype, rect, extra) =>
    ctx.register(
      ctx.obj({
        Type: 'Annot', Subtype: subtype, Rect: rect, F: 4, P: page1.ref,
        T: PDFHexString.fromText('Test Author'), M: str('D:20240115103000Z'),
        ...extra,
      }),
    );
  const w = font.widthOfTextAtSize('This sentence is highlighted.', 14);
  const annots = [
    common('Text', [480, 700, 500, 720], { Contents: PDFHexString.fromText('A sticky note'), C: [1, 0.8, 0], Name: 'Comment' }),
    common('Highlight', [56, 646, 56 + w, 664], {
      Contents: PDFHexString.fromText('Highlighted text'), C: [1, 0.9, 0], CA: 0.5,
      QuadPoints: [56, 664, 56 + w, 664, 56, 646, 56 + w, 646],
    }),
    common('Square', [56, 450, 200, 560], { Contents: PDFHexString.fromText('A rectangle'), C: [0.72, 0.01, 0.16], BS: { W: 2 } }),
    common('Circle', [240, 450, 380, 560], { Contents: PDFHexString.fromText('An ellipse'), C: [0, 0.4, 0.8], BS: { W: 2 } }),
    common('Line', [400, 450, 560, 560], { Contents: PDFHexString.fromText('An arrow'), C: [0, 0.5, 0.2], L: [410, 460, 550, 550], LE: ['None', 'OpenArrow'], BS: { W: 2 } }),
    common('Ink', [56, 250, 300, 400], { Contents: PDFHexString.fromText('Freehand'), C: [0.4, 0, 0.6], InkList: [[60, 300, 100, 380, 150, 260, 200, 390, 290, 300]], BS: { W: 3 } }),
    common('FreeText', [320, 300, 560, 360], { Contents: PDFHexString.fromText('A text box'), DA: str('0 0 0 rg /Helv 14 Tf'), C: [1, 1, 1] }),
    common('Link', [56, 115, 140, 135], { Border: [0, 0, 0], Dest: [page2.ref, name('Fit')] }),
    common('Link', [300, 115, 410, 135], { Border: [0, 0, 0], A: { S: 'URI', URI: str('https://example.com/') } }),
  ];
  for (const ref of annots) page1.node.addAnnot(ref);
  await save(doc, 'annotations.pdf', {
    annotations: ['Text', 'Highlight', 'Square', 'Circle', 'Line', 'Ink', 'FreeText', 'Link', 'Link'],
  });
}

// ----------------------------------------------------------- attachment.pdf
async function attachment() {
  const inner = await newDoc('Embedded PDF');
  const innerFont = await inner.embedFont(StandardFonts.Helvetica);
  heading(inner.addPage([300, 200]), innerFont, 'Inner PDF', 150);
  const innerBytes = await inner.save();

  const doc = await newDoc('Document with attachments');
  const font = await doc.embedFont(StandardFonts.Helvetica);
  heading(doc.addPage(SIZES.letter), font, 'This document has two attachments');
  const text = new TextEncoder().encode('Hello from an attached text file.\n');
  await doc.attach(text, 'notes.txt', {
    mimeType: 'text/plain', description: 'A plain-text note',
    creationDate: FIXED_DATE, modificationDate: FIXED_DATE,
  });
  await doc.attach(innerBytes, 'inner.pdf', {
    mimeType: 'application/pdf', description: 'An embedded PDF',
    creationDate: FIXED_DATE, modificationDate: FIXED_DATE,
  });
  await save(doc, 'attachment.pdf', {
    attachments: [
      { name: 'notes.txt', size: text.length, description: 'A plain-text note' },
      { name: 'inner.pdf', size: innerBytes.length, description: 'An embedded PDF' },
    ],
  });
}

// --------------------------------------------------------------- layers.pdf
// Two optional content groups: "Visible layer" (ON) and "Hidden layer" (OFF).
async function layers() {
  const doc = await newDoc('Document with layers');
  const font = await doc.embedFont(StandardFonts.HelveticaBold);
  const page = doc.addPage(SIZES.letter);
  heading(page, font, 'Optional content');
  const ctx = doc.context;
  const visible = ctx.register(ctx.obj({ Type: 'OCG', Name: PDFHexString.fromText('Visible layer') }));
  const hidden = ctx.register(ctx.obj({ Type: 'OCG', Name: PDFHexString.fromText('Hidden layer') }));
  doc.catalog.set(
    name('OCProperties'),
    ctx.obj({
      OCGs: [visible, hidden],
      D: { Name: str('Default'), Order: [visible, hidden], ON: [visible], OFF: [hidden] },
    }),
  );
  page.node.Resources().set(name('Properties'), ctx.obj({ OC1: visible, OC2: hidden }));
  const bdc = (tag) => PDFOperator.of('BDC', [name('OC'), name(tag)]);
  const emc = () => PDFOperator.of('EMC');

  page.pushOperators(bdc('OC1'));
  page.drawRectangle({ x: 56, y: 450, width: 220, height: 160, color: rgb(0.1, 0.5, 0.25) });
  page.drawText('VISIBLE LAYER', { x: 70, y: 520, size: 18, font, color: rgb(1, 1, 1) });
  page.pushOperators(emc());

  page.pushOperators(bdc('OC2'));
  page.drawRectangle({ x: 320, y: 450, width: 220, height: 160, color: rgb(0.72, 0.01, 0.16) });
  page.drawText('HIDDEN LAYER', { x: 336, y: 520, size: 18, font, color: rgb(1, 1, 1) });
  page.pushOperators(emc());

  await save(doc, 'layers.pdf', {
    layers: [{ name: 'Visible layer', visible: true }, { name: 'Hidden layer', visible: false }],
  });
}

// ------------------------------------------- corrupted.pdf / truncated.pdf
// corrupted.pdf: 5 pages. Page 3's object header has the wrong generation
// number ("N 1 obj" while everything refers to "N 0 R"), so a reader can't
// load that page even after rebuilding the xref table; page 4 has garbage in
// its content stream. Pages 1, 2, 4 and 5 must load; page 3 can't.
// (A dangling page-tree reference would be simpler, but pdf.js then stops
// counting pages at the break — this keeps the later pages reachable.)
async function corrupted() {
  const doc = await newDoc('Damaged document');
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= 5; i++) {
    const page = doc.addPage(SIZES.letter);
    heading(page, font, `Damaged document, page ${i}`);
  }
  // Garbage operators in page 4's content stream (readers should skip them).
  doc.getPage(3).pushOperators(PDFOperator.of('BT'), PDFOperator.of('%%garbage%%'), PDFOperator.of('Tj'));
  const page3Ref = doc.getPage(2).ref;
  let text = Buffer.from(await doc.save({ useObjectStreams: false })).toString('latin1');

  const header = `\n${page3Ref.objectNumber} 0 obj`;
  if (!text.includes(header)) throw new Error('corrupted.pdf: page 3 object not found');
  text = text.replace(header, `\n${page3Ref.objectNumber} 1 obj`); // same length: offsets stay valid
  await writeFile(join(DIR, 'corrupted.pdf'), Buffer.from(text, 'latin1'));
  manifest['corrupted.pdf'] = { pageCount: 5, brokenPages: [3] };
  console.log(`  ${'corrupted.pdf'.padEnd(22)}   5 pages  (page 3 broken)`);

  // truncated.pdf: the multipage sample cut off at 60%. The trailer and the
  // page tree are gone, so this one can't be opened at all: the app must show
  // a clear error rather than a blank screen.
  const full = await multipageBytes();
  const cut = full.slice(0, Math.floor(full.length * 0.6));
  await writeFile(join(DIR, 'truncated.pdf'), cut);
  manifest['truncated.pdf'] = { opens: false, truncatedFrom: 'multipage.pdf' };
  console.log(`  ${'truncated.pdf'.padEnd(22)}   -  pages  (cut at 60%, unopenable)`);
}

let multipageCache;
async function multipageBytes() {
  if (!multipageCache) {
    const { readFile } = await import('node:fs/promises');
    multipageCache = await readFile(join(DIR, 'multipage.pdf'));
  }
  return multipageCache;
}

// ------------------------------------------------------------ encrypted.pdf
async function encrypted() {
  const doc = await newDoc('Password-protected document');
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= 2; i++) heading(doc.addPage(SIZES.letter), font, `Secret page ${i}`);
  const plainPath = join(DIR, '.encrypted-plain.pdf');
  const outPath = join(DIR, 'encrypted.pdf');
  await writeFile(plainPath, await doc.save());
  let tool = null;
  try {
    execFileSync('qpdf', ['--encrypt', PASSWORD, OWNER_PASSWORD, '256', '--', plainPath, outPath], { stdio: 'pipe' });
    tool = 'qpdf';
  } catch {
    try {
      execFileSync('python3', [
        '-c',
        'import sys, pikepdf\n' +
          'pdf = pikepdf.open(sys.argv[1])\n' +
          'pdf.save(sys.argv[2], encryption=pikepdf.Encryption(user=sys.argv[3], owner=sys.argv[4], R=6))',
        plainPath, outPath, PASSWORD, OWNER_PASSWORD,
      ], { stdio: 'pipe' });
      tool = 'pikepdf';
    } catch {
      tool = null;
    }
  }
  await rm(plainPath, { force: true });
  if (tool) {
    manifest['encrypted.pdf'] = { pageCount: 2, password: PASSWORD, ownerPassword: OWNER_PASSWORD, encryptedWith: tool };
    console.log(`  ${'encrypted.pdf'.padEnd(22)}   2 pages  (AES-256 via ${tool})`);
  } else {
    await rm(outPath, { force: true });
    console.log('  encrypted.pdf          skipped: neither qpdf nor pikepdf is available');
  }
}

// ---------------------------------------------------------------------- run
await mkdir(DIR, { recursive: true });
console.log('Generating fixtures in tests/fixtures/');
await multipage();
await mixedSizes();
await outline();
await pageLabels();
await forms();
await annotations();
await attachment();
await layers();
await corrupted();
await encrypted();
await writeFile(join(DIR, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`✓ ${Object.keys(manifest).length} fixtures, manifest.json written`);
