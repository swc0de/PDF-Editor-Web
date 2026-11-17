// Longer jobs (combine, extract, split), run in a disposable worker so they
// can report progress and be cancelled instantly by terminating it.
// Each job: async (PDFLib, args, ctx) where ctx = { helpers, progress(done, total, label), zip(files) }.
// Like ops, jobs are serialised with toString() and must be self-contained.

/**
 * Combine files into one PDF (also used for "extract": one file, some pages).
 * args: { files: [{ name, bytes, pages|null }], bookmarks: boolean, title? }
 */
export async function combine(PDFLib, args, ctx) {
  const H = ctx.helpers;
  const { files, bookmarks } = args;
  const out = await PDFLib.PDFDocument.create({ updateMetadata: false });
  const used = new Set();
  const outline = [];
  const total = files.length + 1;
  for (let k = 0; k < files.length; k++) {
    const f = files[k];
    ctx.progress(k, total, f.name);
    const src = await PDFLib.PDFDocument.load(f.bytes, { updateMetadata: false });
    const pages = f.pages && f.pages.length ? f.pages : src.getPageIndices();
    const part = await H.appendPages(PDFLib, H, out, src, pages, used);
    if (bookmarks) {
      outline.push({ title: f.label || f.name.replace(/\.pdf$/i, ''), page: part.start, open: true, children: part.outline });
    } else {
      outline.push(...part.outline);
    }
    if (k === 0) H.copyMeta(PDFLib, src, out);
  }
  if (outline.length) H.writeOutline(PDFLib, out, outline);
  if (args.title) out.setTitle(args.title);
  ctx.progress(files.length, total, 'save');
  const bytes = await out.save();
  ctx.progress(total, total, 'done');
  return { bytes, pageCount: out.getPageCount() };
}

/**
 * Split one PDF into parts and zip them.
 * args: { bytes, parts: [{ name, pages: number[] }] }
 */
export async function split(PDFLib, args, ctx) {
  const H = ctx.helpers;
  const src = await PDFLib.PDFDocument.load(args.bytes, { updateMetadata: false });
  const files = {};
  const total = args.parts.length + 1;
  for (let k = 0; k < args.parts.length; k++) {
    const part = args.parts[k];
    ctx.progress(k, total, part.name);
    const out = await PDFLib.PDFDocument.create({ updateMetadata: false });
    const { outline } = await H.appendPages(PDFLib, H, out, src, part.pages, new Set());
    if (outline.length) H.writeOutline(PDFLib, out, outline);
    H.copyMeta(PDFLib, src, out);
    files[part.name] = await out.save();
  }
  ctx.progress(args.parts.length, total, 'zip');
  // PDFs are already compressed: store them (fast) rather than deflate.
  const zip = ctx.zip(files);
  ctx.progress(total, total, 'done');
  return { zip, count: args.parts.length, sizes: Object.fromEntries(Object.entries(files).map(([n, b]) => [n, b.length])) };
}
