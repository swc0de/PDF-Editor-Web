// The OCR pipeline for one page: render with pdf.js → preprocess (worker) →
// orientation / deskew on a canvas → Tesseract (worker) → words. Results keep
// what's needed to map each word back to PDF space for the text layer.
import { preprocess } from '../../core/ocr-preprocess.js';
import { canvasToBlob } from '../canvas-encode.js';
import { getPref, setPref } from '../../core/prefs.js';

export const OCR_DPI = 300;
const MAX_SIDE = 3300; // px: bounds memory and time for big pages
const DICT_KEY = 'ocr.dictionary';

// ------------------------------------------------------------ dictionary

/** The user dictionary: corrections the user made, applied to later results. */
export function getDictionary() {
  const d = getPref(DICT_KEY, null);
  return { corrections: { ...(d?.corrections ?? {}) } };
}

export function learnCorrection(from, to) {
  if (!from || !to || from === to) return;
  const d = getDictionary();
  d.corrections[from] = to;
  setPref(DICT_KEY, d);
}

export function clearDictionary() {
  setPref(DICT_KEY, { corrections: {} });
}

/** Apply the dictionary: a word the user corrected before is corrected again. */
export function applyDictionary(words, dict = getDictionary()) {
  for (const w of words) {
    const fix = dict.corrections[w.text];
    if (fix !== undefined) {
      w.original = w.text;
      w.text = fix;
      w.fromDictionary = true;
    }
  }
  return words;
}

// -------------------------------------------------------------- geometry

function rotateCanvas(src, radians) {
  if (!radians) return src;
  const c = Math.abs(Math.cos(radians));
  const s = Math.abs(Math.sin(radians));
  const w = Math.round(src.width * c + src.height * s);
  const h = Math.round(src.width * s + src.height * c);
  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  const ctx = out.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  ctx.translate(w / 2, h / 2);
  ctx.rotate(radians);
  ctx.drawImage(src, -src.width / 2, -src.height / 2);
  return out;
}

/** Map a point in the OCR image back to the rendered page (inverse rotation). */
export function imageToRender(res, x, y) {
  const c = Math.cos(-res.phi);
  const s = Math.sin(-res.phi);
  const dx = x - res.wB / 2;
  const dy = y - res.hB / 2;
  return [res.wA / 2 + dx * c - dy * s, res.hA / 2 + dx * s + dy * c];
}

/**
 * Words of a result as text-layer entries in PDF space:
 * [{ text, x, y, dx, dy, w, size }] (see core/ops/ocr-ops.js).
 */
export function wordsToPdf(res, viewport) {
  const out = [];
  const toPdf = (x, y) => {
    const [ax, ay] = imageToRender(res, x, y);
    return viewport.convertToPdfPoint(ax, ay);
  };
  for (const w of res.words) {
    const [x0, y0, x1, y1] = w.bbox;
    if (x1 - x0 < 1 || y1 - y0 < 1) continue;
    // Baseline: the line's, if Tesseract gave one, else ~ a fifth up from the box bottom.
    let base = y1 - (y1 - y0) * 0.2;
    if (w.baseline) {
      const [bx0, by0, bx1, by1] = w.baseline;
      const tx = bx1 !== bx0 ? (x0 - bx0) / (bx1 - bx0) : 0;
      const by = by0 + (by1 - by0) * Math.max(0, Math.min(1, tx));
      if (by > y0 && by <= y1 + 2) base = by;
    }
    const p0 = toPdf(x0, base);
    const p1 = toPdf(x1, base);
    const pt = toPdf(x0, y0);
    const len = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
    if (!len) continue;
    const dx = (p1[0] - p0[0]) / len;
    const dy = (p1[1] - p0[1]) / len;
    // Height above the baseline (ascender ≈ 0.73 em for Helvetica-like text).
    const above = Math.abs((pt[0] - p0[0]) * -dy + (pt[1] - p0[1]) * dx);
    out.push({ text: w.text, x: p0[0], y: p0[1], dx, dy, w: len, size: Math.max(1, above / 0.73) });
  }
  return out;
}

// ------------------------------------------------------------- pipeline

/**
 * OCR one page. opts: { autoRotate, deskew, denoise, binarize }.
 * Resolves { page, scale, rotation, wA, hA, wB, hB, phi, angle, blob, url, words }.
 */
export async function ocrPage(tab, index, engine, opts, onProgress) {
  const proxy = await tab.pdf.getPage(index + 1);
  const unit = proxy.getViewport({ scale: 1 });
  const scale = Math.min(OCR_DPI / 72, MAX_SIDE / Math.max(unit.width, unit.height));
  const viewport = proxy.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.floor(viewport.width));
  canvas.height = Math.max(1, Math.floor(viewport.height));
  await proxy.render({ canvas, viewport, annotationMode: tab.viewer.pdfjs.AnnotationMode.DISABLE, background: '#ffffff' }).promise;
  onProgress?.('prepare', 0.1);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const { rgba, skew } = await preprocess(ctx.getImageData(0, 0, canvas.width, canvas.height), opts);
  ctx.putImageData(new ImageData(rgba, canvas.width, canvas.height), 0, 0);
  let orientation = 0;
  if (opts.autoRotate) orientation = await detectOrientation(canvas, engine);
  // Canvas rotation is clockwise for positive angles: undo the skew, then the orientation.
  const phi = ((orientation - skew) * Math.PI) / 180;
  const B = rotateCanvas(canvas, phi);
  const blob = await canvasToBlob(B, 'image/png', { timeout: 6000 });
  const res = {
    page: index,
    scale,
    rotation: viewport.rotation,
    wA: canvas.width,
    hA: canvas.height,
    wB: B.width,
    hB: B.height,
    phi,
    angle: orientation - skew,
    blob,
    url: URL.createObjectURL(blob),
    words: [],
  };
  if (B !== canvas) {
    B.width = 0;
    B.height = 0;
  }
  canvas.width = 0;
  canvas.height = 0;
  onProgress?.('recognize', 0);
  res.words = applyDictionary(await engine.recognize(blob, (p) => onProgress?.('recognize', p)));
  return res;
}

/** Quick orientation check (0/90/180/270): the rotation Tesseract reads best, on a small copy. */
async function detectOrientation(canvas, engine) {
  const k = Math.min(1, 1200 / Math.max(canvas.width, canvas.height));
  const small = document.createElement('canvas');
  small.width = Math.round(canvas.width * k);
  small.height = Math.round(canvas.height * k);
  small.getContext('2d').drawImage(canvas, 0, 0, small.width, small.height);
  let best = 0;
  let bestScore = -1;
  for (const deg of [0, 90, 180, 270]) {
    const rotated = rotateCanvas(small, (deg * Math.PI) / 180);
    const words = await engine.recognize(await canvasToBlob(rotated, 'image/png', { timeout: 4000 }));
    const good = words.filter((w) => w.confidence >= 60 && /[\p{L}\p{N}]{2,}/u.test(w.text));
    const score = good.reduce((sum, w) => sum + w.confidence * w.text.length, 0);
    if (score > bestScore) {
      bestScore = score;
      best = deg;
    }
    // Upright and clearly readable: no need to try the others.
    if (deg === 0 && good.length >= 5 && good.length >= words.length * 0.7) break;
  }
  small.width = 0;
  return best;
}

/** Re-OCR a region (image pixels) of a result; resolves words in image coordinates. */
export async function ocrRegion(res, engine, [x0, y0, x1, y1]) {
  const bitmap = await createImageBitmap(res.blob);
  const pad = 6;
  const sx = Math.max(0, Math.floor(Math.min(x0, x1)) - pad);
  const sy = Math.max(0, Math.floor(Math.min(y0, y1)) - pad);
  const sw = Math.min(res.wB, Math.ceil(Math.max(x0, x1)) + pad) - sx;
  const sh = Math.min(res.hB, Math.ceil(Math.max(y0, y1)) + pad) - sy;
  const c = document.createElement('canvas');
  c.width = Math.max(1, sw);
  c.height = Math.max(1, sh);
  c.getContext('2d').drawImage(bitmap, sx, sy, sw, sh, 0, 0, sw, sh);
  bitmap.close?.();
  const words = await engine.recognize(await canvasToBlob(c, 'image/png', { timeout: 4000 }));
  c.width = 0;
  return applyDictionary(words.map((w) => ({
    ...w,
    bbox: [w.bbox[0] + sx, w.bbox[1] + sy, w.bbox[2] + sx, w.bbox[3] + sy],
    baseline: w.baseline ? [w.baseline[0] + sx, w.baseline[1] + sy, w.baseline[2] + sx, w.baseline[3] + sy] : null,
  })));
}
