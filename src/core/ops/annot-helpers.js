// Annotation helpers for the worker: build PDF annotation dictionaries with
// real appearance streams (so Acrobat, Preview and browsers show them), read
// them back, move/resize them and rebuild their appearance.
//
// Each helper is self-contained (serialised into the worker); helpers that use
// others receive the helper table `H`.
//
// Spec objects (what the UI sends) use PDF user-space coordinates:
//   { type: 'highlight'|'underline'|'strikeout'|'square'|'circle'|'line'|'ink'|'freetext'|'note',
//     rect, quads (QuadPoints, 8 numbers each), line [x1,y1,x2,y2], arrow, ink [[x,y,x,y…]…],
//     text, fontSize, color '#rrggbb', opacity 0..1, width, contents, author }

/** "#b70228" → [0.717, 0.008, 0.157] */
export function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
  const n = m ? parseInt(m[1], 16) : 0;
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/** [r,g,b] (0..1) → "#rrggbb" */
export function rgbToHex(rgb) {
  if (!rgb || rgb.length < 3) return '#000000';
  return `#${rgb.slice(0, 3).map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0')).join('')}`;
}

/** pdf.js-style id ("12R", or "12R3" for generation 3) ↔ PDFRef. */
export function refFromId(L, id) {
  const m = /^(\d+)R(\d*)$/.exec(String(id));
  if (!m) throw new Error(`Bad annotation id ${id}`);
  return L.PDFRef.of(Number(m[1]), m[2] ? Number(m[2]) : 0);
}

export function idFromRef(ref) {
  return ref.generationNumber ? `${ref.objectNumber}R${ref.generationNumber}` : `${ref.objectNumber}R`;
}

/** PDF date string for now: D:YYYYMMDDHHmmSSZ */
export function pdfDate(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `D:${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

/** The bounding rect a spec needs (adds stroke/arrow margins). */
export function specRect(spec) {
  const w = Math.max(0.5, Number(spec.width) || 1);
  const pad = (pts) => {
    const xs = pts.filter((_, i) => i % 2 === 0);
    const ys = pts.filter((_, i) => i % 2 === 1);
    const m = spec.type === 'line' && spec.arrow ? w * 3 + 8 : w;
    return [Math.min(...xs) - m, Math.min(...ys) - m, Math.max(...xs) + m, Math.max(...ys) + m];
  };
  if (spec.quads?.length) return pad(spec.quads.flat());
  if (spec.type === 'line' && spec.line) return pad(spec.line);
  if (spec.type === 'ink' && spec.ink?.length) return pad(spec.ink.flat());
  if (spec.type === 'note') {
    const [x, y] = spec.rect;
    return [x, y, x + 20, y + 20];
  }
  const [x0, y0, x1, y1] = spec.rect;
  return [Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)];
}

/** Content stream (PDF operators) drawing a spec, in page coordinates. */
export function appearanceContent(spec, rect) {
  const f = (n) => (Math.round(n * 1000) / 1000).toString();
  const [r, g, b] = (spec.rgb || [0, 0, 0]).map(f);
  const w = Math.max(0.5, Number(spec.width) || 1);
  const ops = ['q', '/GS0 gs'];
  const quads = spec.quads || [];
  switch (spec.type) {
    case 'highlight':
      ops.push(`${r} ${g} ${b} rg`);
      for (const q of quads) ops.push(`${f(q[0])} ${f(q[1])} m ${f(q[2])} ${f(q[3])} l ${f(q[6])} ${f(q[7])} l ${f(q[4])} ${f(q[5])} l f`);
      break;
    case 'underline':
    case 'strikeout':
      ops.push(`${r} ${g} ${b} RG`);
      for (const q of quads) {
        const h = Math.abs(q[1] - q[5]);
        const lw = Math.max(0.6, h * 0.07);
        const t = spec.type === 'underline' ? 0.08 : 0.45;
        const y1 = q[5] + (q[1] - q[5]) * t;
        const y2 = q[7] + (q[3] - q[7]) * t;
        ops.push(`${f(lw)} w ${f(q[4])} ${f(y1)} m ${f(q[6])} ${f(y2)} l S`);
      }
      break;
    case 'square': {
      const [x0, y0, x1, y1] = rect;
      ops.push(`${r} ${g} ${b} RG ${f(w)} w`, `${f(x0 + w / 2)} ${f(y0 + w / 2)} ${f(x1 - x0 - w)} ${f(y1 - y0 - w)} re S`);
      break;
    }
    case 'circle': {
      const [x0, y0, x1, y1] = rect;
      const cx = (x0 + x1) / 2;
      const cy = (y0 + y1) / 2;
      const rx = (x1 - x0 - w) / 2;
      const ry = (y1 - y0 - w) / 2;
      const k = 0.5523;
      ops.push(`${r} ${g} ${b} RG ${f(w)} w`,
        `${f(cx + rx)} ${f(cy)} m`,
        `${f(cx + rx)} ${f(cy + ry * k)} ${f(cx + rx * k)} ${f(cy + ry)} ${f(cx)} ${f(cy + ry)} c`,
        `${f(cx - rx * k)} ${f(cy + ry)} ${f(cx - rx)} ${f(cy + ry * k)} ${f(cx - rx)} ${f(cy)} c`,
        `${f(cx - rx)} ${f(cy - ry * k)} ${f(cx - rx * k)} ${f(cy - ry)} ${f(cx)} ${f(cy - ry)} c`,
        `${f(cx + rx * k)} ${f(cy - ry)} ${f(cx + rx)} ${f(cy - ry * k)} ${f(cx + rx)} ${f(cy)} c S`);
      break;
    }
    case 'line': {
      const [x1, y1, x2, y2] = spec.line;
      ops.push(`${r} ${g} ${b} RG ${f(w)} w 1 J 1 j`, `${f(x1)} ${f(y1)} m ${f(x2)} ${f(y2)} l S`);
      if (spec.arrow) {
        const a = Math.atan2(y2 - y1, x2 - x1);
        const len = w * 3 + 6;
        const p = (da) => `${f(x2 - len * Math.cos(a + da))} ${f(y2 - len * Math.sin(a + da))}`;
        ops.push(`${p(0.45)} m ${f(x2)} ${f(y2)} l ${p(-0.45)} l S`);
      }
      break;
    }
    case 'ink':
      ops.push(`${r} ${g} ${b} RG ${f(w)} w 1 J 1 j`);
      for (const path of spec.ink || []) {
        if (path.length < 2) continue;
        let s = `${f(path[0])} ${f(path[1])} m`;
        for (let i = 2; i + 1 < path.length; i += 2) s += ` ${f(path[i])} ${f(path[i + 1])} l`;
        if (path.length === 2) s += ` ${f(path[0] + 0.01)} ${f(path[1])} l`;
        ops.push(`${s} S`);
      }
      break;
    case 'freetext': {
      const [x0, , , y1] = rect;
      const size = Number(spec.fontSize) || 12;
      const enc = (line) => line
        .replace(/[^\x20-\x7e\xa0-\xff]/g, '?')
        .replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
      ops.push('BT', `/Helv ${f(size)} Tf`, `${r} ${g} ${b} rg`, `${f(size * 1.2)} TL`, `${f(x0 + 4)} ${f(y1 - 4 - size)} Td`);
      String(spec.text ?? '').split('\n').forEach((line, i) => ops.push(`${i ? 'T* ' : ''}(${enc(line)}) Tj`));
      ops.push('ET');
      break;
    }
    case 'note': {
      const [x0, y0] = rect;
      ops.push(`${r} ${g} ${b} rg 0.25 0.25 0.25 RG 0.6 w`,
        `${f(x0 + 1)} ${f(y0 + 4)} 18 15 re B`,
        `${f(x0 + 5)} ${f(y0 + 4)} m ${f(x0 + 4)} ${f(y0 + 0.5)} l ${f(x0 + 9)} ${f(y0 + 4)} l f`,
        '1 1 1 RG 1.1 w',
        `${f(x0 + 4)} ${f(y0 + 14)} m ${f(x0 + 16)} ${f(y0 + 14)} l S`,
        `${f(x0 + 4)} ${f(y0 + 10.5)} m ${f(x0 + 16)} ${f(y0 + 10.5)} l S`,
        `${f(x0 + 4)} ${f(y0 + 7)} m ${f(x0 + 12)} ${f(y0 + 7)} l S`);
      break;
    }
    default:
      break;
  }
  ops.push('Q');
  return ops.join('\n');
}

/** Register an appearance stream (form XObject) for a spec; returns its ref. */
export function makeAppearance(L, H, doc, spec, rect) {
  const ctx = doc.context;
  const opacity = spec.opacity === undefined ? 1 : Math.max(0.05, Math.min(1, Number(spec.opacity)));
  const gs = { Type: 'ExtGState', CA: opacity, ca: opacity };
  if (spec.type === 'highlight') gs.BM = 'Multiply';
  const resources = { ExtGState: { GS0: gs } };
  if (spec.type === 'freetext') {
    resources.Font = { Helv: { Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica', Encoding: 'WinAnsiEncoding' } };
  }
  const stream = ctx.stream(H.appearanceContent(spec, rect), {
    Type: 'XObject',
    Subtype: 'Form',
    BBox: rect,
    Resources: resources,
  });
  return ctx.register(stream);
}

/** Create an annotation from a spec on page `pageIndex`; returns its id. */
export function createAnnotation(L, H, doc, pageIndex, spec) {
  const { PDFHexString, PDFString } = L;
  const ctx = doc.context;
  const page = doc.getPage(pageIndex);
  const s = { ...spec, rgb: H.hexToRgb(spec.color) };
  const rect = H.specRect(s);
  const now = H.pdfDate();
  const dict = {
    Type: 'Annot',
    Subtype: H.SUBTYPES_OF(s.type),
    Rect: rect,
    P: page.ref,
    F: 4,
    NM: PDFString.of(`pdfeditor-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`),
    M: PDFString.of(now),
    CreationDate: PDFString.of(now),
    C: s.rgb,
    CA: s.opacity === undefined ? 1 : Number(s.opacity),
    T: PDFHexString.fromText(s.author || ''),
    Contents: PDFHexString.fromText(s.contents ?? (s.type === 'freetext' ? s.text ?? '' : '')),
  };
  if (['square', 'circle', 'line', 'ink', 'freetext'].includes(s.type)) dict.BS = { Type: 'Border', W: s.type === 'freetext' ? 0 : Number(s.width) || 1, S: 'S' };
  if (s.quads?.length) dict.QuadPoints = s.quads.flat();
  if (s.type === 'line') {
    dict.L = s.line;
    dict.LE = ['None', s.arrow ? 'OpenArrow' : 'None'];
  }
  if (s.type === 'ink') dict.InkList = s.ink;
  if (s.type === 'freetext') {
    dict.DA = PDFString.of(`/Helv ${Number(s.fontSize) || 12} Tf ${s.rgb.map((v) => v.toFixed(3)).join(' ')} rg`);
    dict.Q = 0;
    // For FreeText /C is the background colour; the text colour lives in /DA.
    delete dict.C;
  }
  if (s.type === 'note') {
    dict.Name = 'Comment';
    dict.Open = false;
  }
  dict.AP = { N: H.makeAppearance(L, H, doc, s, rect) };
  const ref = ctx.register(ctx.obj(dict));
  page.node.addAnnot(ref);
  return H.idFromRef(ref);
}

export function SUBTYPES_OF(type) {
  const map = {
    highlight: 'Highlight', underline: 'Underline', strikeout: 'StrikeOut', square: 'Square', circle: 'Circle',
    line: 'Line', ink: 'Ink', freetext: 'FreeText', note: 'Text',
  };
  return map[type];
}

/** Read a spec back from an annotation dict (for rebuilding its appearance). Null if we can't draw it. */
export function specFromDict(L, H, doc, dict) {
  const { PDFName, PDFArray, PDFNumber, PDFDict, PDFString, PDFHexString, PDFRef } = L;
  const N = (n) => PDFName.of(n);
  const lookup = (o) => (o instanceof PDFRef ? doc.context.lookup(o) : o);
  const nums = (o) => {
    const a = lookup(o);
    return a instanceof PDFArray ? a.asArray().map((v) => (lookup(v) instanceof PDFNumber ? lookup(v).asNumber() : 0)) : null;
  };
  const text = (o) => {
    const v = lookup(o);
    return v instanceof PDFString || v instanceof PDFHexString ? v.decodeText() : '';
  };
  const subtype = String(dict.get(N('Subtype'))).replace('/', '');
  const types = { Highlight: 'highlight', Underline: 'underline', StrikeOut: 'strikeout', Square: 'square', Circle: 'circle', Line: 'line', Ink: 'ink', FreeText: 'freetext', Text: 'note' };
  const type = types[subtype];
  if (!type) return null;
  const rgb = nums(dict.get(N('C'))) || [0, 0, 0];
  const ca = lookup(dict.get(N('CA')));
  const bs = lookup(dict.get(N('BS')));
  const bw = bs instanceof PDFDict ? lookup(bs.get(N('W'))) : null;
  const spec = {
    type,
    rgb: rgb.length >= 3 ? rgb.slice(0, 3) : [rgb[0] ?? 0, rgb[0] ?? 0, rgb[0] ?? 0],
    opacity: ca instanceof PDFNumber ? ca.asNumber() : 1,
    width: bw instanceof PDFNumber ? bw.asNumber() : 1,
  };
  if (['highlight', 'underline', 'strikeout'].includes(type)) {
    const q = nums(dict.get(N('QuadPoints'))) || [];
    spec.quads = [];
    for (let i = 0; i + 7 < q.length; i += 8) spec.quads.push(q.slice(i, i + 8));
  }
  if (type === 'line') {
    spec.line = nums(dict.get(N('L'))) || [0, 0, 0, 0];
    const le = lookup(dict.get(N('LE')));
    spec.arrow = le instanceof PDFArray && le.size() > 1 && /Arrow/.test(String(le.get(1)));
  }
  if (type === 'ink') {
    const list = lookup(dict.get(N('InkList')));
    spec.ink = list instanceof PDFArray ? list.asArray().map((p) => nums(p) || []) : [];
  }
  if (type === 'freetext') {
    spec.text = text(dict.get(N('Contents')));
    const da = text(dict.get(N('DA')));
    const m = /([\d.]+)\s+Tf/.exec(da);
    spec.fontSize = m ? Number(m[1]) : 12;
    const color = /([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+rg/.exec(da);
    if (color) spec.rgb = [Number(color[1]), Number(color[2]), Number(color[3])];
  }
  return spec;
}

/** Map every coordinate of a spec from rect `a` to rect `b` (move/resize). */
export function transformSpec(spec, a, b) {
  const sx = (b[2] - b[0]) / Math.max(1e-6, a[2] - a[0]);
  const sy = (b[3] - b[1]) / Math.max(1e-6, a[3] - a[1]);
  const pt = (arr) => arr.map((v, i) => (i % 2 === 0 ? b[0] + (v - a[0]) * sx : b[1] + (v - a[1]) * sy));
  const out = { ...spec };
  if (spec.quads) out.quads = spec.quads.map(pt);
  if (spec.line) out.line = pt(spec.line);
  if (spec.ink) out.ink = spec.ink.map(pt);
  return out;
}

/** Shared by replies and review states: a Text annotation pointing at its parent with /IRT. */
export function createChildAnnotation(L, H, doc, args, extra) {
  const { PDFName, PDFHexString, PDFString } = L;
  const ctx = doc.context;
  const page = doc.getPage(args.page);
  const parentRef = H.refFromId(L, args.parent);
  const parent = ctx.lookup(parentRef);
  const rect = parent.lookup(PDFName.of('Rect')).asArray().map((v) => v.asNumber());
  const now = H.pdfDate();
  // An empty appearance: replies are shown in comment lists, not on the page.
  const ap = ctx.register(ctx.stream('', { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 1, 1] }));
  const ref = ctx.register(ctx.obj({
    Type: 'Annot',
    Subtype: 'Text',
    Rect: rect,
    P: page.ref,
    F: 4 | 8 | 16,
    IRT: parentRef,
    RT: 'R',
    NM: PDFString.of(`pdfeditor-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`),
    M: PDFString.of(now),
    CreationDate: PDFString.of(now),
    T: PDFHexString.fromText(args.author || ''),
    Contents: PDFHexString.fromText(args.contents || ''),
    AP: { N: ap },
    ...extra,
  }));
  page.node.addAnnot(ref);
  return H.idFromRef(ref);
}

