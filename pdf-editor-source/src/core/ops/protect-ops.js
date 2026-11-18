// Redaction and sanitizing (worker). Signature: (PDFLib, doc, args, { helpers }).

/** Read-only: every redaction mark: [{ page, id, rects }]. */
export function listRedactions(PDFLib, doc, args, { helpers: H }) {
  return { value: H.redactionMarks(PDFLib, H, doc) };
}

/** Remove every redaction mark (one step). */
export function removeRedactions(PDFLib, doc, args, { helpers: H }) {
  const marks = H.redactionMarks(PDFLib, H, doc);
  const pages = new Map();
  for (const m of marks) pages.set(m.page, [...(pages.get(m.page) ?? []), H.refFromId(PDFLib, m.id)]);
  for (const [i, refs] of pages) {
    const page = doc.getPage(i);
    for (const ref of refs) {
      page.node.removeAnnot(ref);
      doc.context.delete(ref);
    }
  }
  return { affected: [...pages.keys()], value: { removed: marks.length } };
}

/**
 * Burn redactions in. args.pages: [{ page, jpg: Uint8Array, view: [x0,y0,x1,y1], rects }]
 * Each page's content is replaced by the image (rendered with black boxes on
 * the main thread); its redaction marks and any annotation or form field
 * touching a redacted area are removed; then unreachable objects (the old
 * content, fonts only it used…) are deleted so nothing redacted stays in the file.
 */
export async function applyRedactions(PDFLib, doc, args, { helpers: H }) {
  const { PDFName, PDFArray, PDFDict, PDFRef } = PDFLib;
  const N = (n) => PDFName.of(n);
  const ctx = doc.context;
  const affected = [];
  const hit = (r, rects) => rects.some((b) => r[0] < b[2] && r[2] > b[0] && r[1] < b[3] && r[3] > b[1]);
  const form = doc.catalog.has(N('AcroForm')) ? doc.getForm() : null;
  for (const job of args.pages) {
    const page = doc.getPage(job.page);
    const image = await doc.embedJpg(job.jpg);
    const [x0, y0, x1, y1] = job.view;
    const content = ctx.register(ctx.stream(`q ${x1 - x0} 0 0 ${y1 - y0} ${x0} ${y0} cm /RedactedPage Do Q`));
    page.node.set(N('Contents'), content);
    page.node.set(N('Resources'), ctx.obj({ XObject: { RedactedPage: image.ref }, Font: {}, ExtGState: {} }));
    for (const key of ['Thumb', 'PieceInfo', 'StructParents', 'Group']) page.node.delete(N(key));
    // Annotations: drop the marks and anything overlapping a redacted area.
    const annots = page.node.lookupMaybe(N('Annots'), PDFArray);
    const remove = new Set();
    const fieldsToRemove = new Set();
    if (annots) {
      for (const ref of annots.asArray()) {
        const dict = ctx.lookup(ref);
        if (!(dict instanceof PDFDict)) continue;
        const sub = dict.lookup(N('Subtype'));
        const subtype = sub instanceof PDFName ? sub.asString() : '';
        const r = dict.lookupMaybe(N('Rect'), PDFArray)?.asArray().map((v) => v.asNumber());
        const box = r ? [Math.min(r[0], r[2]), Math.min(r[1], r[3]), Math.max(r[0], r[2]), Math.max(r[1], r[3])] : null;
        if (subtype === '/Redact' || (box && hit(box, job.rects))) {
          remove.add(ref.toString());
          if (subtype === '/Widget' && form) {
            const field = form.getFields().find((f) => H.fieldWidgets(PDFLib, H, doc, f).some((w) => w.ref.toString() === ref.toString()));
            if (field) fieldsToRemove.add(field);
          }
        }
      }
      // Replies and pop-ups of removed annotations go too.
      for (const ref of annots.asArray()) {
        const dict = ctx.lookup(ref);
        if (!(dict instanceof PDFDict)) continue;
        const parent = dict.get(N('IRT')) ?? dict.get(N('Parent'));
        if (parent instanceof PDFRef && remove.has(parent.toString())) remove.add(ref.toString());
      }
    }
    for (const field of fieldsToRemove) H.removeFieldSafe(PDFLib, H, doc, form, field);
    const left = page.node.lookupMaybe(N('Annots'), PDFArray);
    if (left) {
      for (const ref of [...left.asArray()]) {
        if (remove.has(ref.toString())) page.node.removeAnnot(ref);
      }
    }
    affected.push(job.page);
  }
  H.collectGarbage(PDFLib, doc);
  return { affected };
}

/**
 * Remove metadata, scripts/actions, attachments, hidden layers and comments.
 * args: { metadata, javascript, attachments, hiddenLayers, comments, dryRun }
 * With dryRun nothing changes: the counts say what would go. → value { counts }
 */
export function sanitize(PDFLib, doc, args, { helpers: H }) {
  const L = PDFLib;
  const { PDFName, PDFDict, PDFArray, PDFRef, PDFStream } = L;
  const N = (n) => PDFName.of(n);
  const ctx = doc.context;
  const dry = !!args.dryRun;
  const counts = { metadata: 0, javascript: 0, attachments: 0, hiddenLayers: 0, comments: 0 };
  const affected = new Set();
  const pages = doc.getPages();
  const names = doc.catalog.lookup(N('Names'));
  const del = (dict, key) => {
    if (!dry) dict.delete(N(key));
  };
  const subOf = (dict) => {
    const s = dict.lookup(N('Subtype'));
    return s instanceof PDFName ? s.asString().slice(1) : '';
  };
  const removeAnnots = (i, refs) => {
    if (dry || !refs.length) return;
    for (const ref of refs) pages[i].node.removeAnnot(ref);
    affected.add(i);
  };

  // --- Metadata: the Info dictionary, XMP streams and private application data.
  if (args.metadata) {
    const info = ctx.trailerInfo.Info ? ctx.lookup(ctx.trailerInfo.Info) : null;
    if (info instanceof PDFDict) counts.metadata += info.keys().length;
    if (!dry) ctx.trailerInfo.Info = undefined;
    for (const holder of [doc.catalog, ...pages.map((p) => p.node)]) {
      if (holder.has(N('Metadata'))) {
        counts.metadata++;
        del(holder, 'Metadata');
      }
      if (holder.has(N('PieceInfo'))) {
        counts.metadata++;
        del(holder, 'PieceInfo');
      }
    }
  }

  // --- JavaScript and actions that run code, launch files or submit data.
  if (args.javascript) {
    const risky = new Set(['JavaScript', 'Launch', 'SubmitForm', 'ImportData', 'ResetForm', 'Rendition', 'Sound', 'Movie', 'GoToE']);
    const isRisky = (action) => {
      for (let a = action, k = 0; a instanceof PDFDict && k < 20; k++) {
        const s = a.lookup(N('S'));
        if (s instanceof PDFName && risky.has(s.asString().slice(1))) return true;
        const next = a.lookup(N('Next'));
        a = next instanceof PDFArray ? next.lookup(0) : next;
      }
      return false;
    };
    if (names instanceof PDFDict && names.has(N('JavaScript'))) {
      counts.javascript++;
      del(names, 'JavaScript');
    }
    const open = doc.catalog.lookup(N('OpenAction'));
    if (open instanceof PDFDict && isRisky(open)) {
      counts.javascript++;
      del(doc.catalog, 'OpenAction');
    }
    for (const holder of [doc.catalog, ...pages.map((p) => p.node)]) {
      if (holder.has(N('AA'))) {
        counts.javascript++;
        del(holder, 'AA');
      }
    }
    pages.forEach((page, i) => {
      const annots = page.node.lookupMaybe(N('Annots'), PDFArray);
      if (!annots) return;
      const drop = [];
      for (const ref of annots.asArray()) {
        const dict = ctx.lookup(ref);
        if (!(dict instanceof PDFDict)) continue;
        if (dict.has(N('AA'))) {
          counts.javascript++;
          del(dict, 'AA');
          affected.add(i);
        }
        const action = dict.lookup(N('A'));
        if (action instanceof PDFDict && isRisky(action)) {
          counts.javascript++;
          // A link whose only job is a risky action goes; widgets just lose the action.
          if (subOf(dict) === 'Link') drop.push(ref);
          else del(dict, 'A');
          affected.add(i);
        }
      }
      removeAnnots(i, drop);
    });
    // Form field dictionaries (non-widget parents) can carry actions too.
    const acro = doc.catalog.lookup(N('AcroForm'));
    if (acro instanceof PDFDict) {
      const walk = (arr, depth) => {
        if (!(arr instanceof PDFArray) || depth > 20) return;
        for (const ref of arr.asArray()) {
          const f = ref instanceof PDFRef ? ctx.lookup(ref) : ref;
          if (!(f instanceof PDFDict)) continue;
          if (f.has(N('AA'))) {
            counts.javascript++;
            del(f, 'AA');
          }
          walk(f.lookup(N('Kids')), depth + 1);
        }
      };
      walk(acro.lookup(N('Fields')), 0);
    }
  }

  // --- Attachments: embedded files (document level and file-attachment annotations).
  if (args.attachments) {
    if (names instanceof PDFDict && names.has(N('EmbeddedFiles'))) {
      const tree = names.lookup(N('EmbeddedFiles'));
      const countTree = (node, depth) => {
        if (!(node instanceof PDFDict) || depth > 32) return 0;
        const list = node.lookup(N('Names'));
        let n = list instanceof PDFArray ? Math.floor(list.size() / 2) : 0;
        const kids = node.lookup(N('Kids'));
        if (kids instanceof PDFArray) for (let k = 0; k < kids.size(); k++) n += countTree(kids.lookup(k), depth + 1);
        return n;
      };
      counts.attachments += Math.max(1, countTree(tree, 0));
      del(names, 'EmbeddedFiles');
    }
    if (doc.catalog.has(N('AF'))) del(doc.catalog, 'AF');
    pages.forEach((page, i) => {
      const annots = page.node.lookupMaybe(N('Annots'), PDFArray);
      if (!annots) return;
      const drop = annots.asArray().filter((ref) => {
        const dict = ctx.lookup(ref);
        return dict instanceof PDFDict && subOf(dict) === 'FileAttachment';
      });
      counts.attachments += drop.length;
      removeAnnots(i, drop);
    });
  }

  // --- Hidden layers: content in optional content groups that are off by default.
  if (args.hiddenLayers) {
    const hidden = H.hiddenOcgs(L, doc);
    if (hidden.size) {
      counts.hiddenLayers += hidden.size;
      const doneXObjects = new Set();
      const stripStream = (stream, resources) => {
        const props = resources instanceof PDFDict ? resources.lookup(N('Properties')) : null;
        const isHidden = (name) => {
          if (!(props instanceof PDFDict)) return false;
          return H.ocIsHidden(L, doc, props.get(N(name)), hidden);
        };
        const src = H.latin1(H.streamBytes(L, stream));
        return H.stripOptionalContent(src, isHidden);
      };
      const visitXObjects = (resources) => {
        const xobjects = resources instanceof PDFDict ? resources.lookup(N('XObject')) : null;
        if (!(xobjects instanceof PDFDict)) return;
        for (const [, ref] of xobjects.entries()) {
          if (!(ref instanceof PDFRef) || doneXObjects.has(ref.toString())) continue;
          doneXObjects.add(ref.toString());
          const xo = ctx.lookup(ref);
          if (!(xo instanceof PDFStream)) continue;
          const sub = xo.dict.lookup(N('Subtype'));
          if (!(sub instanceof PDFName) || sub.asString() !== '/Form') continue;
          const res = xo.dict.lookup(N('Resources'));
          if (H.ocIsHidden(L, doc, xo.dict.get(N('OC')), hidden)) {
            if (!dry) ctx.assign(ref, ctx.stream('', { Type: 'XObject', Subtype: 'Form', BBox: xo.dict.get(N('BBox')) ?? [0, 0, 0, 0] }));
            continue;
          }
          const { text, removed } = stripStream(xo, res);
          if (removed && !dry) {
            const dict = xo.dict.clone(ctx);
            dict.delete(N('Filter'));
            dict.delete(N('DecodeParms'));
            dict.delete(N('Length'));
            ctx.assign(ref, ctx.flateStream(H.fromLatin1(text), Object.fromEntries(dict.entries().map(([k, v]) => [k.asString().slice(1), v]))));
          }
          visitXObjects(res);
        }
      };
      pages.forEach((page, i) => {
        const resources = page.node.Resources();
        const contents = page.node.Contents();
        const streams = contents instanceof PDFArray ? contents.asArray().map((r) => ctx.lookup(r)) : contents ? [contents] : [];
        const src = streams.filter((st) => st instanceof PDFStream).map((st) => H.latin1(H.streamBytes(L, st))).join('\n');
        const props = resources instanceof PDFDict ? resources.lookup(N('Properties')) : null;
        const isHidden = (name) => props instanceof PDFDict && H.ocIsHidden(L, doc, props.get(N(name)), hidden);
        const { text, removed } = H.stripOptionalContent(src, isHidden);
        if (removed && !dry) {
          page.node.set(N('Contents'), ctx.register(ctx.flateStream(H.fromLatin1(text))));
          affected.add(i);
        }
        visitXObjects(resources);
        // Annotations on a hidden layer.
        const annots = page.node.lookupMaybe(N('Annots'), PDFArray);
        if (annots) {
          const drop = annots.asArray().filter((ref) => {
            const dict = ctx.lookup(ref);
            return dict instanceof PDFDict && H.ocIsHidden(L, doc, dict.get(N('OC')), hidden);
          });
          removeAnnots(i, drop);
        }
      });
      // Forget the hidden groups.
      if (!dry) {
        const props = doc.catalog.lookup(N('OCProperties'));
        const keep = (arr) => {
          if (!(arr instanceof PDFArray)) return;
          for (let k = arr.size() - 1; k >= 0; k--) {
            const v = arr.get(k);
            if (v instanceof PDFRef && hidden.has(v.toString())) arr.remove(k);
            else if (v instanceof PDFArray) keep(v);
            else if (v instanceof PDFRef && ctx.lookup(v) instanceof PDFArray) keep(ctx.lookup(v));
          }
        };
        keep(props.lookup(N('OCGs')));
        const configs = [props.lookup(N('D')), ...(props.lookup(N('Configs'))?.asArray?.().map((r) => ctx.lookup(r)) ?? [])];
        for (const cfg of configs) {
          if (!(cfg instanceof PDFDict)) continue;
          for (const key of ['ON', 'OFF', 'Order', 'Locked', 'RBGroups']) keep(cfg.lookup(N(key)));
        }
        if (!props.lookup(N('OCGs'))?.size()) doc.catalog.delete(N('OCProperties'));
        for (const r of hidden) {
          const [num, gen] = r.split(' ');
          ctx.delete(PDFRef.of(Number(num), Number(gen)));
        }
      }
    }
  }

  // --- Comments and markup (not links, form fields, or our visual signatures).
  if (args.comments) {
    const MARKUP = new Set(['Text', 'FreeText', 'Line', 'Square', 'Circle', 'Polygon', 'PolyLine', 'Highlight', 'Underline', 'Squiggly', 'StrikeOut', 'Stamp', 'Caret', 'Ink', 'Popup', 'Sound', 'Redact']);
    pages.forEach((page, i) => {
      const annots = page.node.lookupMaybe(N('Annots'), PDFArray);
      if (!annots) return;
      const drop = annots.asArray().filter((ref) => {
        const dict = ctx.lookup(ref);
        if (!(dict instanceof PDFDict) || !MARKUP.has(subOf(dict))) return false;
        const nm = dict.lookup(N('Name'));
        return !(subOf(dict) === 'Stamp' && nm instanceof PDFName && nm.asString() === '/PDFEditorSignature');
      });
      counts.comments += drop.filter((ref) => subOf(ctx.lookup(ref)) !== 'Popup').length;
      removeAnnots(i, drop);
    });
  }

  if (!dry) H.collectGarbage(L, doc);
  return { affected: dry ? [] : [...affected], value: { counts } };
}
