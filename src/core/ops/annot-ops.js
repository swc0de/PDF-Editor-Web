// Annotation operations (worker). Signature: (PDFLib, doc, args, { helpers }).

/** Add one or more annotations as one step. items: [{ page, spec }]. Returns ids. */
export function addAnnotations(PDFLib, doc, args, { helpers: H }) {
  const ids = [];
  const pages = new Set();
  for (const { page, spec } of args.items) {
    if (!Number.isInteger(page) || page < 0 || page >= doc.getPageCount()) throw new RangeError(`No page ${page + 1}`);
    ids.push(H.createAnnotation(PDFLib, H, doc, page, spec));
    pages.add(page);
  }
  return { affected: [...pages], value: { ids } };
}

/**
 * Move / resize / restyle / re-text an annotation.
 * args: { page, id, rect?, from?, contents?, color?, opacity?, width?, fontSize? }
 * Annotations we know how to draw get a fresh appearance; others just get the
 * new Rect (viewers scale their existing appearance to it).
 */
export function updateAnnotation(PDFLib, doc, args, { helpers: H }) {
  const { PDFName, PDFHexString, PDFString, PDFArray, PDFNumber } = PDFLib;
  const N = (n) => PDFName.of(n);
  const ref = H.refFromId(PDFLib, args.id);
  const page = doc.getPage(args.page);
  const annots = page.node.Annots();
  if (!annots || !annots.asArray().some((r) => r.toString() === ref.toString())) throw new Error(`Annotation ${args.id} isn't on page ${args.page + 1}`);
  const dict = doc.context.lookup(ref);
  const oldRect = dict.lookup(N('Rect'), PDFArray).asArray().map((v) => v.asNumber());
  let spec = H.specFromDict(PDFLib, H, doc, dict);
  let rect = oldRect;
  if (args.rect) {
    // `from` is the rect the UI measured (pdf.js may report a slightly
    // different one than the stored /Rect); the same transform from→rect is
    // applied to the stored rect and geometry.
    const norm = (r) => [Math.min(r[0], r[2]), Math.min(r[1], r[3]), Math.max(r[0], r[2]), Math.max(r[1], r[3])];
    const to = norm(args.rect);
    const from = norm(args.from || oldRect);
    const sx = (to[2] - to[0]) / Math.max(1e-6, from[2] - from[0]);
    const sy = (to[3] - to[1]) / Math.max(1e-6, from[3] - from[1]);
    rect = norm([to[0] + (oldRect[0] - from[0]) * sx, to[1] + (oldRect[1] - from[1]) * sy, to[0] + (oldRect[2] - from[0]) * sx, to[1] + (oldRect[3] - from[1]) * sy]);
    if (spec) spec = H.transformSpec(spec, oldRect, rect);
    dict.set(N('Rect'), doc.context.obj(rect));
    if (spec?.quads) dict.set(N('QuadPoints'), doc.context.obj(spec.quads.flat()));
    if (spec?.line) dict.set(N('L'), doc.context.obj(spec.line));
    if (spec?.ink) dict.set(N('InkList'), doc.context.obj(spec.ink));
  }
  if (args.contents !== undefined) {
    dict.set(N('Contents'), PDFHexString.fromText(args.contents));
    if (spec?.type === 'freetext') spec.text = args.contents;
  }
  if (args.color) {
    const rgb = H.hexToRgb(args.color);
    // FreeText keeps its text colour in /DA (/C would be its background).
    if (spec?.type !== 'freetext') dict.set(N('C'), doc.context.obj(rgb));
    if (spec) spec.rgb = rgb;
  }
  if (args.opacity !== undefined) {
    dict.set(N('CA'), PDFNumber.of(Number(args.opacity)));
    if (spec) spec.opacity = Number(args.opacity);
  }
  if (args.width !== undefined && spec) {
    spec.width = Number(args.width);
    dict.set(N('BS'), doc.context.obj({ Type: 'Border', W: spec.width, S: 'S' }));
  }
  if (spec?.type === 'freetext') {
    if (args.fontSize) spec.fontSize = Number(args.fontSize);
    dict.set(N('DA'), PDFString.of(`/Helv ${spec.fontSize || 12} Tf ${spec.rgb.map((v) => v.toFixed(3)).join(' ')} rg`));
  }
  if (spec) {
    if (spec.type === 'note' && args.rect) rect = [rect[0], rect[1], rect[0] + 20, rect[1] + 20];
    dict.set(N('Rect'), doc.context.obj(rect));
    dict.set(N('AP'), doc.context.obj({ N: H.makeAppearance(PDFLib, H, doc, spec, rect) }));
  }
  dict.set(N('M'), PDFString.of(H.pdfDate()));
  return { affected: [args.page] };
}

/** Delete annotations (and their replies, review states and popups). args: { page, ids } */
export function deleteAnnotations(PDFLib, doc, args, { helpers: H }) {
  const { PDFName, PDFRef, PDFDict } = PDFLib;
  const N = (n) => PDFName.of(n);
  const ctx = doc.context;
  const page = doc.getPage(args.page);
  const annots = page.node.Annots();
  if (!annots) return { affected: [] };
  const doomed = new Set(args.ids.map((id) => H.refFromId(PDFLib, id).toString()));
  // Replies/states point at their parent with /IRT; popups with /Parent.
  let grew = true;
  while (grew) {
    grew = false;
    for (const r of annots.asArray()) {
      if (!(r instanceof PDFRef) || doomed.has(r.toString())) continue;
      const d = ctx.lookup(r);
      if (!(d instanceof PDFDict)) continue;
      const irt = d.get(N('IRT'));
      const parent = d.get(N('Parent'));
      if ((irt instanceof PDFRef && doomed.has(irt.toString())) || (String(d.get(N('Subtype'))) === '/Popup' && parent instanceof PDFRef && doomed.has(parent.toString()))) {
        doomed.add(r.toString());
        grew = true;
      }
    }
  }
  for (let i = annots.size() - 1; i >= 0; i--) {
    const r = annots.get(i);
    if (r instanceof PDFRef && doomed.has(r.toString())) {
      annots.remove(i);
      ctx.delete(r);
    }
  }
  return { affected: [args.page] };
}

/** Reply to a comment. args: { page, parent, contents, author } */
export function addReply(PDFLib, doc, args, { helpers: H }) {
  const id = H.createChildAnnotation(PDFLib, H, doc, args, {});
  return { affected: [args.page], value: { id } };
}

/**
 * Resolve / reopen a comment the standard way: a review-state reply
 * (StateModel /Review, State /Completed or /None).
 */
export function setReviewState(PDFLib, doc, args, { helpers: H }) {
  const id = H.createChildAnnotation(PDFLib, H, doc, { ...args, contents: args.contents ?? `${args.state} set by ${args.author || ''}`.trim() }, {
    StateModel: PDFLib.PDFString.of('Review'),
    State: PDFLib.PDFString.of(args.state),
  });
  return { affected: [args.page], value: { id } };
}
