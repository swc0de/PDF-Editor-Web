// Helpers for redaction and sanitizing (worker; self-contained, reached via H).

/**
 * Delete every object that can't be reached from the trailer (Root / Info).
 * pdf-lib saves every object it holds, so content we removed (old page
 * streams, attachments, scripts) would otherwise still be in the file.
 */
export function collectGarbage(L, doc) {
  const { PDFRef, PDFDict, PDFArray, PDFStream } = L;
  const ctx = doc.context;
  const seen = new Set();
  const stack = [];
  const visit = (obj) => {
    if (obj instanceof PDFRef) {
      const key = obj.toString();
      if (seen.has(key)) return;
      seen.add(key);
      const target = ctx.lookup(obj);
      if (target) stack.push(target);
    } else if (obj) {
      stack.push(obj);
    }
  };
  const t = ctx.trailerInfo;
  visit(t.Root);
  if (t.Info) visit(t.Info);
  while (stack.length) {
    const obj = stack.pop();
    const dict = obj instanceof PDFStream ? obj.dict : obj instanceof PDFDict ? obj : null;
    if (dict) {
      for (const [, v] of dict.entries()) visit(v);
    } else if (obj instanceof PDFArray) {
      for (const v of obj.asArray()) visit(v);
    }
  }
  let removed = 0;
  for (const [ref] of ctx.enumerateIndirectObjects()) {
    if (!seen.has(ref.toString())) {
      ctx.delete(ref);
      removed++;
    }
  }
  return removed;
}

/** Decoded bytes of a stream (raw or created by pdf-lib in this session). */
export function streamBytes(L, stream) {
  if (stream instanceof L.PDFRawStream) return L.decodePDFRawStream(stream).decode();
  if (typeof stream.getUnencodedContents === 'function') return stream.getUnencodedContents();
  return stream.getContents();
}

export function latin1(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
  return s;
}

export function fromLatin1(str) {
  const out = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) out[i] = str.charCodeAt(i) & 0xff;
  return out;
}

/**
 * Remove marked-content blocks `/OC /Name BDC … EMC` whose optional content
 * is hidden (isHidden(name) is true) from a content stream. Strings, hex
 * strings, comments and inline images are skipped properly. Returns
 * { text, removed }.
 */
export function stripOptionalContent(src, isHidden) {
  const n = src.length;
  const ws = (c) => c === ' ' || c === '\n' || c === '\r' || c === '\t' || c === '\f' || c === '\0';
  const delim = (c) => '()<>[]{}/%'.includes(c);
  let i = 0;
  let out = '';
  let copyFrom = 0;
  let cutStart = -1;
  let hiddenDepth = 0;
  let removed = 0;
  let operands = [];
  let firstOperand = -1;
  while (i < n) {
    const c = src[i];
    if (ws(c)) { i++; continue; }
    if (c === '%') {
      while (i < n && src[i] !== '\n' && src[i] !== '\r') i++;
      continue;
    }
    const start = i;
    let kind = 'op';
    let tok = '';
    if (c === '(') {
      let depth = 0;
      for (; i < n; i++) {
        const ch = src[i];
        if (ch === '\\') { i++; continue; }
        if (ch === '(') depth++;
        else if (ch === ')' && --depth === 0) { i++; break; }
      }
      kind = 'str';
    } else if (c === '<' && src[i + 1] === '<') { i += 2; kind = 'punct'; }
    else if (c === '>' && src[i + 1] === '>') { i += 2; kind = 'punct'; }
    else if (c === '<') {
      const end = src.indexOf('>', i);
      i = end < 0 ? n : end + 1;
      kind = 'hex';
    } else if ('[]{}'.includes(c)) { i++; kind = 'punct'; }
    else if (c === '/') {
      i++;
      while (i < n && !ws(src[i]) && !delim(src[i])) i++;
      tok = src.slice(start + 1, i).replace(/#([0-9a-fA-F]{2})/g, (_, hx) => String.fromCharCode(parseInt(hx, 16)));
      kind = 'name';
    } else {
      while (i < n && !ws(src[i]) && !delim(src[i])) i++;
      if (i === start) { i++; continue; }
      tok = src.slice(start, i);
      if (/^[+-]?(\d|\.\d)/.test(tok) || tok === 'true' || tok === 'false' || tok === 'null') kind = 'num';
    }
    if (kind !== 'op') {
      if (firstOperand < 0) firstOperand = start;
      operands.push({ kind, tok });
      continue;
    }
    const opStart = firstOperand >= 0 ? firstOperand : start;
    if (tok === 'ID') {
      // Inline image data runs to the next whitespace-delimited "EI".
      const re = /\sEI(?=[\s]|$)/g;
      re.lastIndex = i + 1;
      const m = re.exec(src);
      i = m ? m.index + 3 : n;
    } else if (tok === 'BDC' || tok === 'BMC') {
      if (hiddenDepth > 0) {
        hiddenDepth++;
      } else if (tok === 'BDC' && operands.length >= 2 && operands[0].kind === 'name' && operands[0].tok === 'OC'
        && operands[1].kind === 'name' && isHidden(operands[1].tok)) {
        hiddenDepth = 1;
        cutStart = opStart;
      }
    } else if (tok === 'EMC' && hiddenDepth > 0) {
      hiddenDepth--;
      if (hiddenDepth === 0) {
        out += src.slice(copyFrom, cutStart);
        copyFrom = i;
        removed++;
      }
    }
    operands = [];
    firstOperand = -1;
  }
  if (hiddenDepth > 0) {
    out += src.slice(copyFrom, cutStart);
    removed++;
  } else {
    out += src.slice(copyFrom);
  }
  return { text: out, removed };
}

/** Optional content groups that are off in the default configuration (Set of ref strings). */
export function hiddenOcgs(L, doc) {
  const { PDFName, PDFDict, PDFArray, PDFRef } = L;
  const N = (n) => PDFName.of(n);
  const props = doc.catalog.lookup(N('OCProperties'));
  const hidden = new Set();
  if (!(props instanceof PDFDict)) return hidden;
  const all = props.lookup(N('OCGs'));
  const d = props.lookup(N('D'));
  const refs = (arr) => (arr instanceof PDFArray ? arr.asArray().filter((r) => r instanceof PDFRef).map((r) => r.toString()) : []);
  const allRefs = refs(all);
  if (!(d instanceof PDFDict)) return hidden;
  const base = d.lookup(N('BaseState'));
  const on = new Set(refs(d.lookup(N('ON'))));
  const off = new Set(refs(d.lookup(N('OFF'))));
  for (const r of allRefs) {
    const isOff = base instanceof PDFName && base.asString() === '/OFF' ? !on.has(r) : off.has(r);
    if (isOff) hidden.add(r);
  }
  return hidden;
}

/** Is an /OC entry (OCG or OCMD, by ref) hidden by default? */
export function ocIsHidden(L, doc, ref, hidden) {
  const { PDFName, PDFDict, PDFArray, PDFRef } = L;
  if (!(ref instanceof PDFRef)) return false;
  if (hidden.has(ref.toString())) return true;
  const dict = doc.context.lookup(ref);
  if (!(dict instanceof PDFDict)) return false;
  const type = dict.lookup(PDFName.of('Type'));
  if (!(type instanceof PDFName) || type.asString() !== '/OCMD') return false;
  // Default visibility policy AnyOn: hidden only when every listed OCG is off.
  const ocgs = dict.get(PDFName.of('OCGs'));
  const list = ocgs instanceof PDFRef ? [ocgs] : ocgs instanceof PDFArray ? ocgs.asArray() : [];
  const refs = list.filter((r) => r instanceof PDFRef);
  return refs.length > 0 && refs.every((r) => hidden.has(r.toString()));
}

/** Rects (PDF space) of a Redact annotation: its QuadPoints, else its Rect. */
export function redactRects(L, dict) {
  const { PDFName, PDFArray } = L;
  const nums = (a) => (a instanceof PDFArray ? a.asArray().map((v) => (typeof v.asNumber === 'function' ? v.asNumber() : 0)) : null);
  const q = nums(dict.lookup(PDFName.of('QuadPoints')));
  if (q && q.length >= 8) {
    const out = [];
    for (let i = 0; i + 7 < q.length; i += 8) {
      const xs = [q[i], q[i + 2], q[i + 4], q[i + 6]];
      const ys = [q[i + 1], q[i + 3], q[i + 5], q[i + 7]];
      out.push([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]);
    }
    return out;
  }
  const r = nums(dict.lookup(PDFName.of('Rect')));
  return r ? [[Math.min(r[0], r[2]), Math.min(r[1], r[3]), Math.max(r[0], r[2]), Math.max(r[1], r[3])]] : [];
}

/** Every Redact annotation in the document: [{ page, id, rects }]. */
export function redactionMarks(L, H, doc) {
  const { PDFName, PDFArray, PDFDict } = L;
  const marks = [];
  doc.getPages().forEach((page, i) => {
    const annots = page.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
    if (!annots) return;
    for (const ref of annots.asArray()) {
      const dict = doc.context.lookup(ref);
      if (!(dict instanceof PDFDict)) continue;
      const sub = dict.lookup(PDFName.of('Subtype'));
      if (sub instanceof PDFName && sub.asString() === '/Redact') marks.push({ page: i, id: H.idFromRef(ref), rects: H.redactRects(L, dict) });
    }
  });
  return marks;
}

/** Remove an earlier OCR text layer (our marked content streams) from a page. */
export function removeOcrLayer(L, doc, page) {
  const { PDFName, PDFArray, PDFStream, PDFRef } = L;
  const contents = page.node.get(PDFName.of('Contents'));
  const arr = contents instanceof PDFRef ? doc.context.lookup(contents) : contents;
  if (!(arr instanceof PDFArray)) return 0;
  let removed = 0;
  for (let i = arr.size() - 1; i >= 0; i--) {
    const ref = arr.get(i);
    const stream = ref instanceof PDFRef ? doc.context.lookup(ref) : ref;
    if (stream instanceof PDFStream && stream.dict.get(PDFName.of('PDFEditorOCR'))) {
      arr.remove(i);
      if (ref instanceof PDFRef) doc.context.delete(ref);
      removed++;
    }
  }
  return removed;
}
