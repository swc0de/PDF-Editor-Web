// Accessibility facts and fixes (worker). Signature: (PDFLib, doc, args, { helpers }).

/**
 * Read-only: what the accessibility checker needs from the file.
 * → value { tagged, marked, lang, title, displayDocTitle, hasOutline, pageCount,
 *           figures: [{ page, alt }], imagePages: [page], fields: [{ name, kind, tooltip, page }] }
 */
export function accessibilityInfo(PDFLib, doc, args, { helpers: H }) {
  const L = PDFLib;
  const { PDFName, PDFDict, PDFArray, PDFRef, PDFString, PDFHexString, PDFBool, PDFNumber, PDFStream } = L;
  const N = (n) => PDFName.of(n);
  const ctx = doc.context;
  const cat = doc.catalog;
  const text = (o) => (o instanceof PDFString || o instanceof PDFHexString ? o.decodeText() : null);
  const pageIndex = new Map(doc.getPages().map((p, i) => [p.ref.toString(), i]));

  const markInfo = cat.lookup(N('MarkInfo'));
  const marked = markInfo instanceof PDFDict && markInfo.lookup(N('Marked')) === PDFBool.True;
  const structRoot = cat.lookup(N('StructTreeRoot'));
  const lang = text(cat.lookup(N('Lang')))?.trim() || null;
  const prefs = cat.lookup(N('ViewerPreferences'));
  const displayDocTitle = prefs instanceof PDFDict && prefs.lookup(N('DisplayDocTitle')) === PDFBool.True;
  const infoRef = ctx.trailerInfo.Info;
  const info = infoRef ? ctx.lookup(infoRef) : null;
  const title = info instanceof PDFDict ? (text(info.lookup(N('Title'))) ?? '').trim() : '';
  const outlines = cat.lookup(N('Outlines'));
  const hasOutline = outlines instanceof PDFDict && !!outlines.get(N('First'));

  // Figures in the structure tree (custom roles mapped through RoleMap).
  const figures = [];
  if (structRoot instanceof PDFDict) {
    const roleMap = structRoot.lookup(N('RoleMap'));
    const roleOf = (s) => {
      let name = s instanceof PDFName ? s.asString().slice(1) : '';
      for (let k = 0; k < 10 && roleMap instanceof PDFDict; k++) {
        const mapped = roleMap.lookup(N(name));
        if (!(mapped instanceof PDFName)) break;
        name = mapped.asString().slice(1);
      }
      return name;
    };
    const pageOf = (el) => {
      const pg = el.get(N('Pg'));
      if (pg instanceof PDFRef && pageIndex.has(pg.toString())) return pageIndex.get(pg.toString());
      const kids = el.lookup(N('K'));
      const list = kids instanceof PDFArray ? kids.asArray() : kids ? [kids] : [];
      for (const k of list) {
        const kd = k instanceof PDFRef ? ctx.lookup(k) : k;
        if (kd instanceof PDFDict) {
          const p = kd.get(N('Pg'));
          if (p instanceof PDFRef && pageIndex.has(p.toString())) return pageIndex.get(p.toString());
        }
      }
      return null;
    };
    const seen = new Set();
    const walk = (node, depth, inherited) => {
      if (depth > 64) return;
      const list = node instanceof PDFArray ? node.asArray() : [node];
      for (const item of list) {
        if (item instanceof PDFRef) {
          if (seen.has(item.toString())) continue;
          seen.add(item.toString());
        }
        const el = item instanceof PDFRef ? ctx.lookup(item) : item;
        if (!(el instanceof PDFDict)) continue;
        const page = pageOf(el) ?? inherited;
        if (el.has(N('S')) && roleOf(el.get(N('S'))) === 'Figure') {
          const alt = text(el.lookup(N('Alt'))) ?? text(el.lookup(N('ActualText')));
          figures.push({ page, alt: alt && alt.trim() ? alt.trim() : null });
        }
        const kids = el.lookup(N('K'));
        if (kids instanceof PDFArray || kids instanceof PDFDict) walk(kids, depth + 1, page);
      }
    };
    walk(structRoot.lookup(N('K')), 0, null);
  }

  // Pages that draw images (directly or in form XObjects one level down).
  const imagePages = [];
  doc.getPages().forEach((page, i) => {
    const hasImage = (resources, depth) => {
      const xo = resources instanceof PDFDict ? resources.lookup(N('XObject')) : null;
      if (!(xo instanceof PDFDict)) return false;
      for (const [, v] of xo.entries()) {
        const s = v instanceof PDFRef ? ctx.lookup(v) : v;
        if (!(s instanceof PDFStream)) continue;
        const sub = s.dict.lookup(N('Subtype'));
        if (sub instanceof PDFName && sub.asString() === '/Image') return true;
        if (depth < 2 && sub instanceof PDFName && sub.asString() === '/Form' && hasImage(s.dict.lookup(N('Resources')), depth + 1)) return true;
      }
      return false;
    };
    if (hasImage(page.node.Resources(), 0)) imagePages.push(i);
  });

  // Form fields and their accessible names (/TU).
  const fields = [];
  if (cat.has(N('AcroForm'))) {
    try {
      const form = doc.getForm();
      const index = H.annotPageIndex(L, doc);
      for (const field of form.getFields()) {
        const kind = H.fieldKind(L, field);
        if (kind === 'button') continue;
        const tu = text(field.acroField.dict.lookup(N('TU')));
        const widget = H.fieldWidgets(L, H, doc, field, index)[0];
        fields.push({ name: field.getName(), kind, tooltip: tu && tu.trim() ? tu.trim() : null, page: widget ? widget.page : null });
      }
    } catch {
      /* a broken form: no field report */
    }
  }

  return {
    value: {
      tagged: structRoot instanceof PDFDict,
      marked,
      lang,
      title,
      displayDocTitle,
      hasOutline,
      pageCount: doc.getPageCount(),
      figures,
      imagePages,
      fields,
    },
  };
}

/** Set the document language (catalog /Lang, BCP 47 like "en-GB"). args: { lang } */
export function setLanguage(PDFLib, doc, args) {
  const lang = String(args.lang ?? '').trim();
  if (!/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(lang)) throw new Error(`“${lang}” isn't a language tag`);
  doc.catalog.set(PDFLib.PDFName.of('Lang'), PDFLib.PDFString.of(lang));
  return { affected: [] };
}

/** Make viewers show the document title (not the file name) in their title bar. */
export function setDisplayDocTitle(PDFLib, doc) {
  const { PDFName, PDFDict, PDFBool } = PDFLib;
  let prefs = doc.catalog.lookup(PDFName.of('ViewerPreferences'));
  if (!(prefs instanceof PDFDict)) {
    prefs = doc.context.obj({});
    doc.catalog.set(PDFName.of('ViewerPreferences'), prefs);
  }
  prefs.set(PDFName.of('DisplayDocTitle'), PDFBool.True);
  return { affected: [] };
}
