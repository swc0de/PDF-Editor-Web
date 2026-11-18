// Page operations, executed inside the pdf-lib worker.
//
// Each op is a self-contained function `(PDFLib, doc, args) => result` — it
// is serialised with Function.prototype.toString() into the worker, so it
// must not reference anything outside its own body (no imports, no closures).
// Return { affected: number[] | null } — the 0-based pages whose content
// changed (null = "anything may have changed").

export function rotatePages(PDFLib, doc, args) {
  const { pages, delta } = args;
  const count = doc.getPageCount();
  for (const index of pages) {
    if (!Number.isInteger(index) || index < 0 || index >= count) throw new RangeError(`No page ${index + 1}`);
    const page = doc.getPage(index);
    const current = page.getRotation().angle || 0;
    page.setRotation(PDFLib.degrees((((current + delta) % 360) + 360) % 360));
  }
  return { affected: [...pages] };
}

/**
 * Delete pages. Bookmarks that point at a deleted page are removed (a
 * bookmark with children keeps its children and just loses its target), and
 * form fields whose widgets were all on deleted pages are removed too.
 */
export function deletePages(PDFLib, doc, args) {
  const { PDFName, PDFRef, PDFArray, PDFDict } = PDFLib;
  const count = doc.getPageCount();
  const pages = [...new Set(args.pages)].sort((a, b) => b - a);
  if (!pages.length) return { affected: [] };
  if (pages.length >= count) throw new Error('A document needs at least one page');
  for (const i of pages) if (!Number.isInteger(i) || i < 0 || i >= count) throw new RangeError(`No page ${i + 1}`);

  const ctx = doc.context;
  const lookup = (o) => (o instanceof PDFRef ? ctx.lookup(o) : o);
  const removedPages = new Set();
  const removedAnnots = new Set();
  for (const i of pages) {
    const page = doc.getPage(i);
    removedPages.add(page.ref.toString());
    const annots = lookup(page.node.get(PDFName.of('Annots')));
    if (annots instanceof PDFArray) {
      for (let k = 0; k < annots.size(); k++) {
        const a = annots.get(k);
        if (a instanceof PDFRef) removedAnnots.add(a.toString());
      }
    }
  }

  // Form fields that live only on deleted pages.
  try {
    const form = doc.getForm();
    for (const field of form.getFields()) {
      const widgetRefs = field.acroField.getWidgets().map((w) => ctx.getObjectRef(w.dict)?.toString());
      if (widgetRefs.length && widgetRefs.every((r) => r && removedAnnots.has(r))) {
        try {
          form.removeField(field);
        } catch {
          // e.g. signature fields: at least drop it from the form's field list
          // (its widget goes away with the page).
          try {
            form.acroForm.removeField(field.acroField);
          } catch {
            /* leave it */
          }
        }
      }
    }
  } catch {
    /* no form */
  }

  for (const i of pages) doc.removePage(i);
  // pdf-lib's removePage() leaves its page cache stale.
  doc.pageCache?.invalidate?.();

  // Bookmarks pointing at deleted pages.
  const outlinesRef = doc.catalog.get(PDFName.of('Outlines'));
  const root = lookup(outlinesRef);
  const N = (n) => PDFName.of(n);
  const destPage = (item) => {
    let dest = lookup(item.get(N('Dest')));
    if (!dest) {
      const action = lookup(item.get(N('A')));
      if (action instanceof PDFDict && String(action.get(N('S'))) === '/GoTo') dest = lookup(action.get(N('D')));
    }
    if (dest instanceof PDFArray && dest.get(0) instanceof PDFRef) return dest.get(0).toString();
    return null;
  };
  const prune = (parent) => {
    const kept = [];
    let ref = parent.get(N('First'));
    let guard = 0;
    while (ref instanceof PDFRef && guard++ < 100000) {
      const item = ctx.lookup(ref);
      if (!(item instanceof PDFDict)) break;
      const next = item.get(N('Next'));
      const hasKids = item.get(N('First')) instanceof PDFRef;
      if (hasKids) prune(item);
      const stillHasKids = item.get(N('First')) instanceof PDFRef;
      const dead = removedPages.has(destPage(item));
      if (dead && !stillHasKids) {
        // drop it
      } else {
        if (dead) {
          item.delete(N('Dest'));
          item.delete(N('A'));
        }
        kept.push(ref);
      }
      ref = next;
    }
    kept.forEach((r, k) => {
      const item = ctx.lookup(r);
      item.set(N('Parent'), parent === root ? outlinesRef : ctx.getObjectRef(parent));
      if (k > 0) item.set(N('Prev'), kept[k - 1]);
      else item.delete(N('Prev'));
      if (k < kept.length - 1) item.set(N('Next'), kept[k + 1]);
      else item.delete(N('Next'));
    });
    if (kept.length) {
      parent.set(N('First'), kept[0]);
      parent.set(N('Last'), kept.at(-1));
      const old = parent.get(N('Count'));
      const closed = parent !== root && old && old.asNumber && old.asNumber() < 0;
      parent.set(N('Count'), ctx.obj(closed ? -kept.length : kept.length));
    } else {
      parent.delete(N('First'));
      parent.delete(N('Last'));
      parent.delete(N('Count'));
    }
  };
  if (root instanceof PDFDict) prune(root);

  return { affected: null };
}

/** Duplicate pages; each copy goes right after its original. */
export async function duplicatePages(PDFLib, doc, args) {
  const pages = [...new Set(args.pages)].sort((a, b) => b - a);
  const count = doc.getPageCount();
  for (const i of pages) {
    if (!Number.isInteger(i) || i < 0 || i >= count) throw new RangeError(`No page ${i + 1}`);
    const [copy] = await doc.copyPages(doc, [i]);
    doc.insertPage(i + 1, copy);
  }
  return { affected: null };
}

/** Insert a blank page of `size` [w, h] (points) at index `at`. */
export function insertBlank(PDFLib, doc, args) {
  const { at, size, rotate = 0 } = args;
  if (!Number.isInteger(at) || at < 0 || at > doc.getPageCount()) throw new RangeError('Bad position');
  const page = doc.insertPage(at, [size[0], size[1]]);
  if (rotate) page.setRotation(PDFLib.degrees(rotate));
  return { affected: null };
}

/** Insert pages (0-based `pages`, or all) of another PDF at index `at`. */
export async function insertFromPdf(PDFLib, doc, args) {
  const { at, bytes } = args;
  if (!Number.isInteger(at) || at < 0 || at > doc.getPageCount()) throw new RangeError('Bad position');
  const src = await PDFLib.PDFDocument.load(bytes, { updateMetadata: false });
  const pages = args.pages ?? src.getPageIndices();
  const copies = await doc.copyPages(src, pages);
  copies.forEach((page, k) => doc.insertPage(at + k, page));
  return { affected: null, value: { inserted: copies.length } };
}

/**
 * Put the pages in a new order. `order[k]` is the old index of the page that
 * ends up at position k (a permutation). The page objects themselves are
 * kept, so bookmarks and links that point at them still work.
 */
export function reorderPages(PDFLib, doc, args) {
  const { order } = args;
  const count = doc.getPageCount();
  const seen = new Set(order);
  if (order.length !== count || seen.size !== count || order.some((i) => !Number.isInteger(i) || i < 0 || i >= count)) {
    throw new Error('Invalid page order');
  }
  const pages = doc.getPages();
  for (let i = count - 1; i >= 0; i--) doc.removePage(i);
  order.forEach((old, k) => doc.insertPage(k, pages[old]));
  return { affected: null };
}
