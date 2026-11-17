// Document-level operations: metadata, attachments, and a font inspection
// (read-only). Self-contained functions, serialised into the worker.

/** Set title / author / subject / keywords (strings; keywords comma-separated). */
export function setMetadata(PDFLib, doc, args) {
  const { title, author, subject, keywords } = args;
  if (title !== undefined) doc.setTitle(title);
  if (author !== undefined) doc.setAuthor(author);
  if (subject !== undefined) doc.setSubject(subject);
  if (keywords !== undefined) doc.setKeywords(String(keywords).split(/\s*[,;]\s*/).map((k) => k.trim()).filter(Boolean));
  return { affected: [] };
}

/** Embed a file attachment. */
export async function addAttachment(PDFLib, doc, args) {
  const { name, bytes, mimeType, description } = args;
  const now = new Date();
  await doc.attach(bytes, name, {
    mimeType: mimeType || 'application/octet-stream',
    description: description || undefined,
    creationDate: now,
    modificationDate: now,
  });
  return { affected: [] };
}

/** Remove the first embedded file named `name` (name tree + catalog /AF). */
export function removeAttachment(PDFLib, doc, args) {
  const { PDFName, PDFRef, PDFDict, PDFArray, PDFString, PDFHexString } = PDFLib;
  const N = (n) => PDFName.of(n);
  const ctx = doc.context;
  const lookup = (o) => (o instanceof PDFRef ? ctx.lookup(o) : o);
  const text = (o) => (o instanceof PDFString || o instanceof PDFHexString ? o.decodeText() : null);
  const fileName = (spec) => {
    const d = lookup(spec);
    if (!(d instanceof PDFDict)) return null;
    return text(lookup(d.get(N('UF')))) ?? text(lookup(d.get(N('F'))));
  };
  let removedSpec = null;
  const prune = (node, depth) => {
    if (!(node instanceof PDFDict) || depth > 32 || removedSpec) return;
    const names = lookup(node.get(N('Names')));
    if (names instanceof PDFArray) {
      for (let i = 0; i + 1 < names.size(); i += 2) {
        const key = text(lookup(names.get(i)));
        const spec = names.get(i + 1);
        if (key === args.name || fileName(spec) === args.name) {
          removedSpec = spec;
          names.remove(i + 1);
          names.remove(i);
          return;
        }
      }
    }
    const kids = lookup(node.get(N('Kids')));
    if (kids instanceof PDFArray) for (let i = 0; i < kids.size(); i++) prune(lookup(kids.get(i)), depth + 1);
  };
  const namesDict = lookup(doc.catalog.get(N('Names')));
  if (namesDict instanceof PDFDict) prune(lookup(namesDict.get(N('EmbeddedFiles'))), 0);
  if (!removedSpec) throw new Error(`No attachment named ${args.name}`);
  const af = lookup(doc.catalog.get(N('AF')));
  if (af instanceof PDFArray) {
    for (let i = af.size() - 1; i >= 0; i--) {
      const item = af.get(i);
      if (item === removedSpec || (item instanceof PDFRef && removedSpec instanceof PDFRef && item.toString() === removedSpec.toString())) af.remove(i);
    }
  }
  if (removedSpec instanceof PDFRef) {
    const spec = ctx.lookup(removedSpec);
    const ef = spec instanceof PDFDict ? lookup(spec.get(N('EF'))) : null;
    const stream = ef instanceof PDFDict ? ef.get(N('F')) : null;
    if (stream instanceof PDFRef) ctx.delete(stream);
    ctx.delete(removedSpec);
  }
  return { affected: [] };
}

/**
 * Read-only: every font used by page content (including inside form XObjects),
 * with its type and whether it's embedded / a subset.
 */
export function inspectFonts(PDFLib, doc) {
  const { PDFName, PDFRef, PDFDict, PDFArray, PDFStream } = PDFLib;
  const N = (n) => PDFName.of(n);
  const ctx = doc.context;
  const lookup = (o) => (o instanceof PDFRef ? ctx.lookup(o) : o);
  const fonts = new Map();
  const seenRes = new Set();
  const dictOf = (o) => {
    const v = lookup(o);
    return v instanceof PDFStream ? v.dict : v instanceof PDFDict ? v : null;
  };
  const describe = (fontDict) => {
    const subtype = String(fontDict.get(N('Subtype')) ?? '').replace('/', '');
    const base = String(fontDict.get(N('BaseFont')) ?? '/(unnamed)').replace(/^\//, '');
    let descriptorHolder = fontDict;
    if (subtype === 'Type0') {
      const desc = lookup(fontDict.get(N('DescendantFonts')));
      if (desc instanceof PDFArray && desc.size()) descriptorHolder = lookup(desc.get(0));
    }
    const fd = descriptorHolder instanceof PDFDict ? lookup(descriptorHolder.get(N('FontDescriptor'))) : null;
    const embedded = subtype === 'Type3' || (fd instanceof PDFDict && ['FontFile', 'FontFile2', 'FontFile3'].some((k) => fd.has(N(k))));
    const subset = /^[A-Z]{6}\+/.test(base);
    return { name: subset ? base.slice(7) : base, rawName: base, type: subtype, embedded, subset };
  };
  const visitResources = (res, page, depth) => {
    res = dictOf(res);
    if (!res || depth > 8) return;
    const key = ctx.getObjectRef(res)?.toString();
    if (key && seenRes.has(`${key}:${page}`)) return;
    if (key) seenRes.add(`${key}:${page}`);
    const fontRes = dictOf(res.get(N('Font')));
    if (fontRes) {
      for (const [, ref] of fontRes.entries()) {
        const f = dictOf(ref);
        if (!f) continue;
        const id = ref instanceof PDFRef ? ref.toString() : `${page}:${String(f.get(N('BaseFont')))}`;
        if (!fonts.has(id)) fonts.set(id, { ...describe(f), pages: new Set() });
        fonts.get(id).pages.add(page);
      }
    }
    const xobjects = dictOf(res.get(N('XObject')));
    if (xobjects) {
      for (const [, ref] of xobjects.entries()) {
        const x = dictOf(ref);
        if (x && String(x.get(N('Subtype'))) === '/Form') visitResources(x.get(N('Resources')), page, depth + 1);
      }
    }
  };
  doc.getPages().forEach((p, i) => visitResources(p.node.Resources(), i, 0));
  const list = [...fonts.values()].map((f) => ({ ...f, pages: [...f.pages].sort((a, b) => a - b) }));
  list.sort((a, b) => a.name.localeCompare(b.name));
  return { value: { fonts: list } };
}
