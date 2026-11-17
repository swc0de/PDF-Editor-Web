// Helpers shared by the worker jobs (combine, split, extract).
//
// Like the ops, each helper is a self-contained function serialised into the
// worker with toString(). Helpers that need another helper receive the
// helper table `H` as an argument.

/** Read a document's outline: [{ title, page (0-based|null), open, children }]. */
export function readOutline(L, doc) {
  const { PDFName, PDFRef, PDFDict, PDFArray, PDFString, PDFHexString, PDFNumber } = L;
  const N = (n) => PDFName.of(n);
  const ctx = doc.context;
  const lookup = (o) => (o instanceof PDFRef ? ctx.lookup(o) : o);
  const pageIndex = new Map(doc.getPages().map((p, i) => [p.ref.toString(), i]));
  const text = (o) => (o instanceof PDFString || o instanceof PDFHexString ? o.decodeText() : o instanceof PDFName ? o.decodeText() : null);

  // Named destinations: catalog /Dests (dict) and /Names /Dests (name tree).
  const named = (name) => {
    const dests = lookup(doc.catalog.get(N('Dests')));
    if (dests instanceof PDFDict) {
      const hit = lookup(dests.get(N(name)));
      if (hit) return hit;
    }
    const names = lookup(doc.catalog.get(N('Names')));
    const tree = names instanceof PDFDict ? lookup(names.get(N('Dests'))) : null;
    const search = (node, depth) => {
      if (!(node instanceof PDFDict) || depth > 32) return null;
      const list = lookup(node.get(N('Names')));
      if (list instanceof PDFArray) {
        for (let i = 0; i + 1 < list.size(); i += 2) {
          if (text(lookup(list.get(i))) === name) return lookup(list.get(i + 1));
        }
      }
      const kids = lookup(node.get(N('Kids')));
      if (kids instanceof PDFArray) {
        for (let i = 0; i < kids.size(); i++) {
          const found = search(lookup(kids.get(i)), depth + 1);
          if (found) return found;
        }
      }
      return null;
    };
    return search(tree, 0);
  };

  const destPage = (item) => {
    let dest = lookup(item.get(N('Dest')));
    if (!dest) {
      const action = lookup(item.get(N('A')));
      if (action instanceof PDFDict && String(action.get(N('S'))) === '/GoTo') dest = lookup(action.get(N('D')));
    }
    const name = text(dest);
    if (name !== null) dest = named(name);
    if (dest instanceof PDFDict) dest = lookup(dest.get(N('D')));
    if (!(dest instanceof PDFArray)) return null;
    const first = dest.get(0);
    if (first instanceof PDFRef) return pageIndex.get(first.toString()) ?? null;
    if (first instanceof PDFNumber) return first.asNumber();
    return null;
  };

  const seen = new Set();
  const walk = (firstRef, depth) => {
    const out = [];
    let ref = firstRef;
    while (ref instanceof PDFRef && !seen.has(ref.toString()) && depth < 64) {
      seen.add(ref.toString());
      const item = ctx.lookup(ref);
      if (!(item instanceof PDFDict)) break;
      const count = lookup(item.get(N('Count')));
      out.push({
        title: text(lookup(item.get(N('Title')))) ?? '',
        page: destPage(item),
        open: count instanceof PDFNumber ? count.asNumber() > 0 : false,
        children: walk(item.get(N('First')), depth + 1),
      });
      ref = item.get(N('Next'));
    }
    return out;
  };
  const root = lookup(doc.catalog.get(N('Outlines')));
  return root instanceof PDFDict ? walk(root.get(N('First')), 0) : [];
}

/**
 * Translate outline pages with `map(oldIndex) → newIndex | null`. Items whose
 * page didn't make it are dropped unless they still have children (then they
 * point at their first child's page).
 */
export function mapOutline(items, map) {
  const out = [];
  for (const item of items) {
    const children = mapOutline(item.children || [], map);
    const page = item.page === null || item.page === undefined ? null : map(item.page);
    if (page === null && !children.length) continue;
    out.push({ title: item.title, open: item.open, page: page ?? children[0].page, children });
  }
  return out;
}

/** Write an outline tree ({ title, page, open, children }) as the document's /Outlines. */
export function writeOutline(L, doc, items) {
  const { PDFName, PDFHexString } = L;
  const N = (n) => PDFName.of(n);
  const ctx = doc.context;
  const pages = doc.getPages();
  const rootRef = ctx.nextRef();
  const build = (nodes, parentRef) => {
    const refs = nodes.map(() => ctx.nextRef());
    let visible = 0;
    nodes.forEach((node, i) => {
      const dict = {
        Title: PDFHexString.fromText(node.title || ''),
        Parent: parentRef,
      };
      const page = pages[Math.max(0, Math.min(pages.length - 1, node.page ?? 0))];
      if (page) dict.Dest = [page.ref, N('XYZ'), null, null, null];
      if (i > 0) dict.Prev = refs[i - 1];
      if (i < nodes.length - 1) dict.Next = refs[i + 1];
      if (node.children && node.children.length) {
        const sub = build(node.children, refs[i]);
        dict.First = sub.first;
        dict.Last = sub.last;
        dict.Count = node.open ? sub.count : -sub.count;
        if (node.open) visible += sub.count;
      }
      ctx.assign(refs[i], ctx.obj(dict));
      visible += 1;
    });
    return { first: refs[0], last: refs[refs.length - 1], count: visible };
  };
  if (!items.length) return;
  const top = build(items, rootRef);
  ctx.assign(rootRef, ctx.obj({ Type: 'Outlines', First: top.first, Last: top.last, Count: top.count }));
  doc.catalog.set(N('Outlines'), rootRef);
}

/**
 * After copyPages(): register the form fields whose widgets came along in
 * `out`'s AcroForm, renaming top-level fields whose names are already used.
 */
export function carryFields(L, out, src, copiedPages, usedNames) {
  const { PDFName, PDFRef, PDFDict, PDFArray, PDFHexString, PDFString, PDFObjectCopier } = L;
  const N = (n) => PDFName.of(n);
  const ctx = out.context;
  const lookup = (o) => (o instanceof PDFRef ? ctx.lookup(o) : o);
  const roots = [];
  const seen = new Set();
  for (const page of copiedPages) {
    const annots = lookup(page.node.get(N('Annots')));
    if (!(annots instanceof PDFArray)) continue;
    for (let i = 0; i < annots.size(); i++) {
      let ref = annots.get(i);
      let node = lookup(ref);
      if (!(node instanceof PDFDict) || String(node.get(N('Subtype'))) !== '/Widget') continue;
      let guard = 0;
      while (node.get(N('Parent')) instanceof PDFRef && guard++ < 32) {
        ref = node.get(N('Parent'));
        node = ctx.lookup(ref);
      }
      if (!(ref instanceof PDFRef) || seen.has(ref.toString())) continue;
      seen.add(ref.toString());
      roots.push({ ref, node });
    }
  }
  if (!roots.length) return 0;

  let acro = lookup(out.catalog.get(N('AcroForm')));
  if (!(acro instanceof PDFDict)) {
    acro = ctx.obj({ Fields: [] });
    out.catalog.set(N('AcroForm'), ctx.register(acro));
  }
  let fields = lookup(acro.get(N('Fields')));
  if (!(fields instanceof PDFArray)) {
    fields = ctx.obj([]);
    acro.set(N('Fields'), fields);
  }
  for (const { ref, node } of roots) {
    const t = node.get(N('T'));
    let name = t instanceof PDFString || t instanceof PDFHexString ? t.decodeText() : null;
    if (name !== null) {
      if (usedNames.has(name)) {
        let k = 2;
        while (usedNames.has(`${name}_${k}`)) k++;
        name = `${name}_${k}`;
        node.set(N('T'), PDFHexString.fromText(name));
      }
      usedNames.add(name);
    }
    fields.push(ref);
  }
  // Default appearance resources so viewers can draw the fields.
  const srcAcro = src.catalog.lookup(N('AcroForm'));
  if (srcAcro instanceof PDFDict) {
    const copier = PDFObjectCopier.for(src.context, ctx);
    for (const key of ['DR', 'DA', 'NeedAppearances']) {
      const v = srcAcro.get(N(key));
      if (v !== undefined && acro.get(N(key)) === undefined) acro.set(N(key), copier.copy(v));
    }
  }
  return roots.length;
}

/** Copy title/author/subject/keywords/creator/language from one document to another. */
export function copyMeta(L, src, out) {
  const s = (f) => {
    try {
      return f();
    } catch {
      return undefined;
    }
  };
  const title = s(() => src.getTitle());
  const author = s(() => src.getAuthor());
  const subject = s(() => src.getSubject());
  const keywords = s(() => src.getKeywords());
  const creator = s(() => src.getCreator());
  if (title) out.setTitle(title);
  if (author) out.setAuthor(author);
  if (subject) out.setSubject(subject);
  if (keywords) out.setKeywords(keywords.split(/\s*[,;]\s*|\s+/).filter(Boolean));
  if (creator) out.setCreator(creator);
  const lang = src.catalog.get(L.PDFName.of('Lang'));
  if (lang) out.catalog.set(L.PDFName.of('Lang'), lang);
  out.setProducer('PDF Editor');
}

/**
 * Copy pages (one copyPages call, so links between them keep working),
 * their form fields, the matching part of the outline and the metadata.
 * Returns the new pages' starting index in `out`.
 */
export async function appendPages(L, H, out, src, pages, usedNames) {
  const { PDFName, PDFNumber } = L;
  const TAG = PDFName.of('PDFEditorSrcPage');
  // Tag source pages so link targets can be traced after copying (pdf-lib's
  // copier gives each page a link points at its own detached clone).
  src.getPages().forEach((p, i) => p.node.set(TAG, PDFNumber.of(i)));
  const start = out.getPageCount();
  const copies = await out.copyPages(src, pages);
  copies.forEach((p) => out.addPage(p));
  const placed = new Map();
  pages.forEach((p, k) => {
    if (!placed.has(p)) placed.set(p, copies[k]);
  });
  H.fixLinks(L, out, copies, placed, TAG);
  H.carryFields(L, out, src, copies, usedNames);
  const outline = H.mapOutline(H.readOutline(L, src), (i) => (placed.has(i) ? start + pages.indexOf(i) : null));
  return { start, outline };
}

/**
 * Point copied links at the placed copies of their target pages; links to
 * pages that weren't copied lose their destination. Detached page clones are
 * deleted so they don't bloat the file. Removes the TAG afterwards.
 */
export function fixLinks(L, out, copies, placed, TAG) {
  const { PDFName, PDFRef, PDFDict, PDFArray, PDFNumber } = L;
  const N = (n) => PDFName.of(n);
  const ctx = out.context;
  const lookup = (o) => (o instanceof PDFRef ? ctx.lookup(o) : o);
  const placedRefs = new Set(copies.map((p) => p.ref.toString()));
  const orphans = new Map();
  for (const page of copies) {
    const annots = lookup(page.node.get(N('Annots')));
    if (!(annots instanceof PDFArray)) continue;
    for (let i = 0; i < annots.size(); i++) {
      const annot = lookup(annots.get(i));
      if (!(annot instanceof PDFDict) || String(annot.get(N('Subtype'))) !== '/Link') continue;
      let holder = annot;
      let key = 'Dest';
      let dest = lookup(annot.get(N('Dest')));
      if (!dest) {
        const action = lookup(annot.get(N('A')));
        if (action instanceof PDFDict && String(action.get(N('S'))) === '/GoTo') {
          holder = action;
          key = 'D';
          dest = lookup(action.get(N('D')));
        }
      }
      if (!(dest instanceof PDFArray) || !(dest.get(0) instanceof PDFRef)) continue;
      const targetRef = dest.get(0);
      if (placedRefs.has(targetRef.toString())) continue;
      const target = ctx.lookup(targetRef);
      const tag = target instanceof PDFDict ? target.get(TAG) : null;
      if (!(tag instanceof PDFNumber)) continue;
      orphans.set(targetRef.toString(), targetRef);
      const real = placed.get(tag.asNumber());
      if (real) {
        dest.set(0, real.ref);
      } else {
        holder.delete(N(key));
        if (holder !== annot) annot.delete(N('A'));
      }
    }
  }
  for (const ref of orphans.values()) ctx.delete(ref);
  for (const page of copies) page.node.delete(TAG);
}
