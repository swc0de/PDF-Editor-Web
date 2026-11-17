// Form helpers for the worker ops (forms, signatures). Self-contained
// functions: they reach each other through the helper table `H`.

/** A field by its fully qualified name (throws if there's none). */
export function getField(form, name) {
  const field = form.getFields().find((f) => f.getName() === name);
  if (!field) throw new Error(`No form field named “${name}”`);
  return field;
}

/** The page index of every annotation ref: Map("12 0 R" → page index). */
export function annotPageIndex(L, doc) {
  const { PDFName, PDFArray } = L;
  const map = new Map();
  doc.getPages().forEach((page, i) => {
    const annots = page.node.lookup(PDFName.of('Annots'), PDFArray);
    if (annots) for (const ref of annots.asArray()) map.set(ref.toString(), i);
  });
  return map;
}

/** Widgets of a pdf-lib field: [{ widget, ref, page }]. */
export function fieldWidgets(L, H, doc, field, pages = H.annotPageIndex(L, doc)) {
  return field.acroField.getWidgets().map((widget) => {
    const ref = doc.context.getObjectRef(widget.dict) ?? field.ref;
    return { widget, ref, page: pages.get(ref.toString()) ?? -1 };
  });
}

/** Field type names used by the UI. */
export function fieldKind(L, field) {
  if (field instanceof L.PDFTextField) return 'text';
  if (field instanceof L.PDFCheckBox) return 'checkbox';
  if (field instanceof L.PDFRadioGroup) return 'radio';
  if (field instanceof L.PDFDropdown) return 'dropdown';
  if (field instanceof L.PDFOptionList) return 'list';
  if (field instanceof L.PDFSignature) return 'signature';
  if (field instanceof L.PDFButton) return 'button';
  return 'unknown';
}

/**
 * Regenerate a field's appearances (Helvetica). Text the font can't encode
 * falls back to /NeedAppearances so viewers build their own.
 */
export function refreshField(L, H, doc, form, field) {
  const { PDFName, PDFBool } = L;
  if (field instanceof L.PDFSignature) {
    for (const { widget } of H.fieldWidgets(L, H, doc, field)) H.signatureFieldAppearance(L, doc, widget);
    return true;
  }
  try {
    form.markFieldAsDirty(field.ref);
    if (field instanceof L.PDFCheckBox || field instanceof L.PDFRadioGroup) field.defaultUpdateAppearances();
    else field.defaultUpdateAppearances(form.getDefaultFont());
    form.markFieldAsClean(field.ref);
    return true;
  } catch (err) {
    form.acroForm.dict.set(PDFName.of('NeedAppearances'), PDFBool.True);
    return false;
  }
}

/** A plain bordered box as a signature field's appearance. */
export function signatureFieldAppearance(L, doc, widget) {
  const { PDFName } = L;
  const r = widget.getRectangle();
  const w = Math.max(1, r.width);
  const hgt = Math.max(1, r.height);
  const ops = `q 0.5 0.5 0.5 RG 1 w 0.5 0.5 ${w - 1} ${hgt - 1} re S Q`;
  const stream = doc.context.stream(ops, { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, w, hgt] });
  widget.dict.set(PDFName.of('AP'), doc.context.obj({ N: doc.context.register(stream) }));
}

/** Remove a field and its widgets (pdf-lib's removeField misses separate widgets). */
export function removeFieldSafe(L, H, doc, form, field) {
  const { PDFRef } = L;
  const widgets = H.fieldWidgets(L, H, doc, field);
  const pages = doc.getPages();
  for (const { ref, page } of widgets) {
    if (page >= 0) pages[page].node.removeAnnot(ref);
    else for (const p of pages) p.node.removeAnnot(ref);
  }
  for (const p of pages) p.node.removeAnnot(field.ref);
  form.acroForm.removeField(field.acroField);
  const kids = field.acroField.normalizedEntries().Kids;
  for (let i = 0; i < kids.size(); i++) {
    const kid = kids.get(i);
    if (kid instanceof PDFRef) doc.context.delete(kid);
  }
  doc.context.delete(field.ref);
  return widgets.map((w) => w.page).filter((p) => p >= 0);
}

/**
 * Flatten every field: draw each visible widget's current appearance into its
 * page, then remove the field. Widgets without an appearance just go.
 */
export function flattenFields(L, H, doc, form) {
  const { PDFName, PDFDict, PDFStream, PDFRef, PDFArray, PDFNumber } = L;
  const N = (n) => PDFName.of(n);
  const ctx = doc.context;
  const pages = doc.getPages();
  const index = H.annotPageIndex(L, doc);
  const affected = new Set();
  for (const field of form.getFields()) {
    for (const { widget, ref, page } of H.fieldWidgets(L, H, doc, field, index)) {
      if (page < 0) continue;
      affected.add(page);
      const flags = widget.dict.lookup(N('F'));
      if (flags instanceof PDFNumber && flags.asNumber() & 2) continue; // hidden
      let ap = widget.dict.lookup(N('AP'));
      let normal = ap instanceof PDFDict ? ap.get(N('N')) : null;
      let stream = normal instanceof PDFRef ? ctx.lookup(normal) : normal;
      if (stream instanceof PDFDict && !(stream instanceof PDFStream)) {
        // Checkbox / radio: pick the state the widget shows.
        const as = widget.dict.lookup(N('AS'));
        const pick = (as instanceof PDFName && stream.get(as)) || stream.get(N('Off'));
        normal = pick;
        stream = pick instanceof PDFRef ? ctx.lookup(pick) : pick;
      }
      if (!(stream instanceof PDFStream)) continue;
      const streamRef = normal instanceof PDFRef ? normal : ctx.register(stream);
      const r = widget.getRectangle();
      const bbox = stream.dict.lookup(N('BBox'), PDFArray)?.asArray().map((v) => v.asNumber()) ?? [0, 0, r.width, r.height];
      const bw = Math.max(1e-6, bbox[2] - bbox[0]);
      const bh = Math.max(1e-6, bbox[3] - bbox[1]);
      const sx = r.width / bw;
      const sy = r.height / bh;
      const key = pages[page].node.newXObject('FlatWidget', streamRef);
      // pushOperators wraps the existing content in q/Q first.
      pages[page].pushOperators(
        L.pushGraphicsState(),
        L.concatTransformationMatrix(sx, 0, 0, sy, r.x - bbox[0] * sx, r.y - bbox[1] * sy),
        L.drawObject(key),
        L.popGraphicsState(),
      );
    }
    H.removeFieldSafe(L, H, doc, form, field);
  }
  return [...affected];
}

/** Next free field name like "Text 3". */
export function uniqueFieldName(form, base) {
  const names = new Set(form.getFields().map((f) => f.getName()));
  for (let i = 1; ; i++) {
    const name = `${base} ${i}`;
    if (!names.has(name)) return name;
  }
}
