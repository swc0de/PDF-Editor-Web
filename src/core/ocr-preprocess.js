// OCR preprocessing on raw pixels, in a Blob worker: grayscale, denoise
// (3×3 median), binarize (Otsu threshold) and skew estimation (projection
// profiles). Rotation itself is done on a canvas by the caller.

/** The worker body: functions below are inlined by toString(). */
function preprocessWorkerMain(toGray, median3, otsu, estimateSkew) {
  self.onmessage = (e) => {
    const { id, width, height, rgba, denoise, binarize, deskew } = e.data;
    try {
      let gray = toGray(new Uint8ClampedArray(rgba), width, height);
      if (denoise) gray = median3(gray, width, height);
      let skew = 0;
      if (deskew) skew = estimateSkew(gray, width, height, otsu(gray));
      if (binarize) {
        const t = otsu(gray);
        for (let i = 0; i < gray.length; i++) gray[i] = gray[i] > t ? 255 : 0;
      }
      const out = new Uint8ClampedArray(width * height * 4);
      for (let i = 0, j = 0; i < gray.length; i++, j += 4) {
        out[j] = out[j + 1] = out[j + 2] = gray[i];
        out[j + 3] = 255;
      }
      self.postMessage({ id, rgba: out.buffer, skew }, [out.buffer]);
    } catch (err) {
      self.postMessage({ id, error: String((err && err.message) || err) });
    }
  };
}

export function toGray(rgba, width, height) {
  const gray = new Uint8ClampedArray(width * height);
  for (let i = 0, j = 0; i < gray.length; i++, j += 4) {
    // Luma, with transparent pixels as white paper.
    const a = rgba[j + 3] / 255;
    gray[i] = Math.round((0.299 * rgba[j] + 0.587 * rgba[j + 1] + 0.114 * rgba[j + 2]) * a + 255 * (1 - a));
  }
  return gray;
}

/** 3×3 median filter (removes speckles, keeps edges). */
export function median3(src, width, height) {
  const out = new Uint8ClampedArray(src.length);
  const win = new Uint8Array(9);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = Math.min(height - 1, Math.max(0, y + dy));
        for (let dx = -1; dx <= 1; dx++) {
          const xx = Math.min(width - 1, Math.max(0, x + dx));
          win[n++] = src[yy * width + xx];
        }
      }
      // Partial insertion sort is enough for 9 values.
      for (let i = 1; i < 9; i++) {
        const v = win[i];
        let k = i - 1;
        while (k >= 0 && win[k] > v) {
          win[k + 1] = win[k];
          k--;
        }
        win[k + 1] = v;
      }
      out[y * width + x] = win[4];
    }
  }
  return out;
}

/** Otsu's threshold for a grayscale image. */
export function otsu(gray) {
  const hist = new Float64Array(256);
  for (let i = 0; i < gray.length; i++) hist[gray[i]]++;
  const total = gray.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0;
  let wB = 0;
  let best = 0;
  let threshold = 127;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) {
      best = between;
      threshold = t;
    }
  }
  return threshold;
}

/**
 * Skew of text lines, in degrees (positive = lines run down to the right in
 * image coordinates). The angle whose projection profile has the sharpest
 * peaks (largest sum of squares) wins; searched in ±6°.
 */
export function estimateSkew(gray, width, height, threshold) {
  const step = Math.max(1, Math.round(width / 700));
  const xs = [];
  const ys = [];
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      if (gray[y * width + x] <= threshold) {
        xs.push(x / step);
        ys.push(y / step);
      }
    }
  }
  if (xs.length < 50) return 0;
  const rows = Math.ceil(height / step) + Math.ceil(width / step) + 4;
  const offset = Math.ceil(width / step) + 2;
  const score = (deg) => {
    const t = Math.tan((deg * Math.PI) / 180);
    const hist = new Float64Array(rows);
    for (let i = 0; i < xs.length; i++) {
      const r = Math.round(ys[i] - xs[i] * t) + offset;
      if (r >= 0 && r < rows) hist[r]++;
    }
    let s = 0;
    for (let i = 0; i < rows; i++) s += hist[i] * hist[i];
    return s;
  };
  let best = 0;
  let bestScore = -1;
  for (let d = -6; d <= 6.0001; d += 0.25) {
    const sc = score(d);
    if (sc > bestScore) {
      bestScore = sc;
      best = d;
    }
  }
  const coarse = best;
  for (let d = coarse - 0.25; d <= coarse + 0.25001; d += 0.05) {
    const sc = score(d);
    if (sc > bestScore) {
      bestScore = sc;
      best = d;
    }
  }
  return Math.abs(best) < 0.1 ? 0 : Math.round(best * 100) / 100;
}

let worker = null;
let nextId = 1;
const pending = new Map();

function getWorker() {
  if (!worker) {
    const src = `;(${preprocessWorkerMain.toString()})(${toGray.toString()}, ${median3.toString()}, ${otsu.toString()}, ${estimateSkew.toString()});`;
    worker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
    worker.onmessage = (e) => {
      const p = pending.get(e.data.id);
      pending.delete(e.data.id);
      if (!p) return;
      if (e.data.error) p.reject(new Error(e.data.error));
      else p.resolve({ rgba: new Uint8ClampedArray(e.data.rgba), skew: e.data.skew });
    };
  }
  return worker;
}

/** Preprocess an ImageData off the main thread. Resolves { rgba, skew }. */
export function preprocess(imageData, { denoise = false, binarize = false, deskew = false } = {}) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    const buf = imageData.data.buffer;
    getWorker().postMessage({ id, width: imageData.width, height: imageData.height, rgba: buf, denoise, binarize, deskew }, [buf]);
  });
}
