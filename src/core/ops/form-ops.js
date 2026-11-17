// Form and signature operations (worker). Signature: (PDFLib, doc, args, { helpers }).
// Field names are fully qualified (as pdf.js reports them in `fieldName`).

/**
 * Set field values. values: [{ name, value }] where value is a string (text,
 * radio, dropdown), a boolean (checkbox) or an array (list / multi-select).
 * The appearances are regenerated so every viewer shows the new values.
 */
export function setFieldValues(PDFLib, doc, args, { helpers: H }) {
  const L = PDFLib;
  const form = doc.getForm();
  const pages = new Set();
  const index = H.annotPageIndex(L, doc);
  for (const { name, value } of args.values) {
    const field = H.getField(form, name);
    if (field.isReadOnly()) throw new Error(`The field “${name}” is read-only`);
    if (field instanceof L.PDFTextField) {
      const text = String(value ?? '');
      const max = field.getMaxLength();
      field.setText(max !== undefined && text.length > max ? text.slice(0, max) : text);
    } else if (field instanceof L.PDFCheckBox) {
      if (value) field.check();
      else field.uncheck();
    } else if (field instanceof L.PDFRadioGroup) {
      if (value) field.select(String(value));
      else field.clear();
    } else if (field instanceof L.PDFDropdown || field instanceof L.PDFOptionList) {
      const list = (Array.isArray(value) ? value : [value]).filter((v) => v !== null && v !== undefined && v !== '');
      if (list.length) field.select(list.length === 1 ? list[0] : list);
      else field.clear();
    } else {
      throw new Error(`The field “${name}” can't be filled`);
    }
    H.refreshField(L, H, doc, form, field);
    for (const w of H.fieldWidgets(L, H, doc, field, index)) if (w.page >= 0) pages.add(w.page);
  }
  return { affected: [...pages] };
}

/** Read-only: one field's properties for the field dialog. args: { name } */
export function fieldInfo(PDFLib, doc, args, { helpers: H }) {
  const L = PDFLib;
  const { PDFName, PDFString, PDFHexString } = L;
  const form = doc.getForm();
  const field = H.getField(form, args.name);
  const kind = H.fieldKind(L, field);
  const dv = field.acroField.dict.lookup(PDFName.of('DV'));
  let defaultValue = null;
  if (dv instanceof PDFString || dv instanceof PDFHexString) defaultValue = dv.decodeText();
  else if (dv instanceof PDFName) defaultValue = kind === 'checkbox' ? dv.decodeText() !== 'Off' : dv.decodeText();
  const info = {
    name: field.getName(),
    partialName: field.acroField.getPartialName() ?? field.getName(),
    kind,
    required: field.isRequired(),
    readOnly: field.isReadOnly(),
    defaultValue,
  };
  if (field instanceof L.PDFDropdown || field instanceof L.PDFOptionList) info.options = field.getOptions();
  if (field instanceof L.PDFTextField) info.multiline = field.isMultiline();
  return { value: info };
}

/**
 * Add a field. args: { page, kind: 'text'|'checkbox'|'dropdown'|'signature',
 * rect: [x0,y0,x1,y1], name?, options? } → value { name, id }
 */
export function addField(PDFLib, doc, args, { helpers: H }) {
  const L = PDFLib;
  const { rgb, PDFHexString } = L;
  const form = doc.getForm();
  const page = doc.getPage(args.page);
  const [x0, y0, x1, y1] = args.rect;
  const box = { x: Math.min(x0, x1), y: Math.min(y0, y1), width: Math.max(4, Math.abs(x1 - x0)), height: Math.max(4, Math.abs(y1 - y0)) };
  const base = { text: 'Text', checkbox: 'Checkbox', dropdown: 'Dropdown', signature: 'Signature' }[args.kind];
  if (!base) throw new Error(`Unknown field kind ${args.kind}`);
  const name = args.name || H.uniqueFieldName(form, base);
  if (/\./.test(name)) throw new Error('Field names can’t contain “.”');
  if (form.getFields().some((f) => f.getName() === name)) throw new Error(`A field named “${name}” already exists`);
  const style = { ...box, borderColor: rgb(0.45, 0.45, 0.45), borderWidth: 1, backgroundColor: rgb(1, 1, 1) };
  let field;
  if (args.kind === 'text') {
    field = form.createTextField(name);
    field.addToPage(page, { ...style, font: form.getDefaultFont() });
  } else if (args.kind === 'checkbox') {
    field = form.createCheckBox(name);
    field.addToPage(page, style);
  } else if (args.kind === 'dropdown') {
    field = form.createDropdown(name);
    field.addOptions(args.options?.length ? args.options : ['Option 1', 'Option 2']);
    field.addToPage(page, { ...style, font: form.getDefaultFont() });
  } else {
    const ctx = doc.context;
    const ref = ctx.register(ctx.obj({
      FT: 'Sig', T: PDFHexString.fromText(name), Type: 'Annot', Subtype: 'Widget',
      Rect: [box.x, box.y, box.x + box.width, box.y + box.height], F: 4, P: page.ref, MK: { BC: [0.5, 0.5, 0.5] },
    }));
    page.node.addAnnot(ref);
    form.acroForm.addField(ref);
    field = H.getField(form, name);
    H.refreshField(L, H, doc, form, field);
  }
  const [widget] = H.fieldWidgets(L, H, doc, field);
  return { affected: [args.page], value: { name, id: widget ? `${widget.ref.objectNumber}R${widget.ref.generationNumber || ''}` : null } };
}

/**
 * Change a field's properties. args: { name, newName?, required?, defaultValue?, options? }
 * The default value also becomes the current value.
 */
export function setFieldProps(PDFLib, doc, args, { helpers: H }) {
  const L = PDFLib;
  const { PDFName, PDFHexString } = L;
  const form = doc.getForm();
  const field = H.getField(form, args.name);
  const kind = H.fieldKind(L, field);
  if (args.newName !== undefined && args.newName !== field.acroField.getPartialName()) {
    const partial = String(args.newName).trim();
    if (!partial) throw new Error('A field needs a name');
    if (/\./.test(partial)) throw new Error('Field names can’t contain “.”');
    const prefix = field.getName().slice(0, field.getName().length - (field.acroField.getPartialName() ?? '').length);
    if (form.getFields().some((f) => f !== field && f.getName() === prefix + partial)) throw new Error(`A field named “${prefix + partial}” already exists`);
    field.acroField.setPartialName(partial);
  }
  if (args.required !== undefined) {
    if (args.required) field.enableRequired();
    else field.disableRequired();
  }
  if (args.options && (field instanceof L.PDFDropdown || field instanceof L.PDFOptionList)) {
    const keep = field.getSelected().filter((v) => args.options.includes(v));
    field.setOptions(args.options);
    if (keep.length) field.select(keep.length === 1 ? keep[0] : keep);
    else field.clear();
  }
  if (args.defaultValue !== undefined) {
    const dict = field.acroField.dict;
    const v = args.defaultValue;
    if (kind === 'text') {
      dict.set(PDFName.of('DV'), PDFHexString.fromText(String(v ?? '')));
      field.setText(String(v ?? ''));
    } else if (kind === 'checkbox') {
      const on = field.acroField.getOnValue?.() ?? PDFName.of('Yes');
      dict.set(PDFName.of('DV'), v ? on : PDFName.of('Off'));
      if (v) field.check();
      else field.uncheck();
    } else if (kind === 'dropdown' || kind === 'list') {
      if (v) {
        dict.set(PDFName.of('DV'), PDFHexString.fromText(String(v)));
        field.select(String(v));
      } else {
        dict.delete(PDFName.of('DV'));
        field.clear();
      }
    }
  }
  H.refreshField(L, H, doc, form, field);
  const pages = H.fieldWidgets(L, H, doc, field).map((w) => w.page).filter((p) => p >= 0);
  return { affected: [...new Set(pages)], value: { name: field.getName() } };
}

/** Move / resize one widget. args: { id: "12R", rect: [x0,y0,x1,y1] } */
export function setWidgetRect(PDFLib, doc, args, { helpers: H }) {
  const L = PDFLib;
  const form = doc.getForm();
  const index = H.annotPageIndex(L, doc);
  for (const field of form.getFields()) {
    for (const w of H.fieldWidgets(L, H, doc, field, index)) {
      if (`${w.ref.objectNumber}R${w.ref.generationNumber || ''}` !== args.id) continue;
      const [x0, y0, x1, y1] = args.rect;
      w.widget.setRectangle({ x: Math.min(x0, x1), y: Math.min(y0, y1), width: Math.max(4, Math.abs(x1 - x0)), height: Math.max(4, Math.abs(y1 - y0)) });
      H.refreshField(L, H, doc, form, field);
      return { affected: w.page >= 0 ? [w.page] : [] };
    }
  }
  throw new Error(`No form field widget ${args.id}`);
}

/** Delete a field and all its widgets. args: { name } */
export function removeField(PDFLib, doc, args, { helpers: H }) {
  const form = doc.getForm();
  const pages = H.removeFieldSafe(PDFLib, H, doc, form, H.getField(form, args.name));
  return { affected: [...new Set(pages)] };
}

/** Flatten the whole form into page content. */
export function flattenForm(PDFLib, doc, args, { helpers: H }) {
  const form = doc.getForm();
  for (const field of form.getFields()) {
    try {
      if (!(field instanceof PDFLib.PDFSignature) && !(field instanceof PDFLib.PDFButton)) H.refreshField(PDFLib, H, doc, form, field);
    } catch {
      /* keep its current appearance */
    }
  }
  return { affected: H.flattenFields(PDFLib, H, doc, form) };
}

/**
 * Place a visual signature: a Stamp annotation whose appearance is the PNG.
 * args: { page, rect, png: Uint8Array, author?, contents? } → value { id }
 */
export async function addSignature(PDFLib, doc, args, { helpers: H }) {
  const { PDFName, PDFString, PDFHexString } = PDFLib;
  const ctx = doc.context;
  const image = await doc.embedPng(args.png);
  const [x0, y0, x1, y1] = args.rect;
  const rect = [Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)];
  const w = rect[2] - rect[0];
  const hgt = rect[3] - rect[1];
  const ap = ctx.register(ctx.stream(`q ${w} 0 0 ${hgt} 0 0 cm /Img Do Q`, {
    Type: 'XObject', Subtype: 'Form', BBox: [0, 0, w, hgt], Resources: { XObject: { Img: image.ref } },
  }));
  const page = doc.getPage(args.page);
  const now = H.pdfDate();
  const ref = ctx.register(ctx.obj({
    Type: 'Annot', Subtype: 'Stamp', Rect: rect, P: page.ref, F: 4,
    Name: PDFName.of('PDFEditorSignature'),
    Subj: PDFHexString.fromText('Signature'),
    Contents: PDFHexString.fromText(args.contents ?? 'Visual signature'),
    T: PDFHexString.fromText(args.author ?? ''),
    NM: PDFString.of(`pdfeditor-sig-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`),
    M: PDFString.of(now), CreationDate: PDFString.of(now),
    AP: { N: ap },
  }));
  page.node.addAnnot(ref);
  return { affected: [args.page], value: { id: H.idFromRef(ref) } };
}
