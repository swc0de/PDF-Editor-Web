// OCR engine: Tesseract.js (lazy-loaded) running in our own classic Blob
// workers. Everything the worker needs is downloaded on the main thread and
// put into the worker's source, so it works from file:// with no worker
// network access:
//   1. a tiny fetch() shim serving `<lang>.traineddata.gz` from embedded data,
//   2. tesseract.js-core (defines the global `TesseractCore`, so Tesseract's
//      worker script doesn't importScripts() it from the CDN),
//   3. Tesseract's own worker script.
import { libUrl, OCR_LANGUAGES } from './libs.config.js';

const downloads = new Map();
function download(name, file, as) {
  const key = `${name}:${file}:${as}`;
  if (!downloads.has(key)) {
    const p = fetch(libUrl(name, file)).then((r) => {
      if (!r.ok) throw new Error(`${name} download failed (${r.status})`);
      return as === 'text' ? r.text() : r.arrayBuffer();
    });
    p.catch(() => downloads.delete(key));
    downloads.set(key, p);
  }
  return downloads.get(key);
}

/** SIMD support (same probe as wasm-feature-detect). */
function hasSimd() {
  try {
    return WebAssembly.validate(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]));
  } catch {
    return false;
  }
}

function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Runs first in the worker: serve trained data from the embedded copies. */
function fetchShim(langs) {
  const decoded = {};
  const realFetch = self.fetch.bind(self);
  self.fetch = (url, opts) => {
    const m = /\/([a-z_]+)\.traineddata(?:\.gz)?$/.exec(String(url));
    if (m && langs[m[1]]) {
      if (!decoded[m[1]]) {
        const bin = atob(langs[m[1]]);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        decoded[m[1]] = bytes;
        delete langs[m[1]];
      }
      return Promise.resolve(new Response(decoded[m[1]].slice()));
    }
    return realFetch(url, opts);
  };
}

export const LANG_PATH = 'https://pdf-editor.invalid/tessdata';
const blobs = new Map();

/** Downloads a language's data (cached for the session). Resolves its size in bytes. */
export async function preloadLanguage(code, onProgress) {
  if (!OCR_LANGUAGES.includes(code)) throw new Error(`Unsupported OCR language: ${code}`);
  onProgress?.(code);
  const buf = await download(`tessdata_${code}`, 'main', 'buffer');
  return buf.byteLength;
}

async function workerUrl(langs) {
  const key = [...langs].sort().join('+');
  if (!blobs.has(key)) {
    const p = (async () => {
      const [core, worker, ...data] = await Promise.all([
        download('tesseractCore', hasSimd() ? 'simd' : 'plain', 'text'),
        download('tesseract', 'worker', 'text'),
        ...langs.map((code) => download(`tessdata_${code}`, 'main', 'buffer')),
      ]);
      const embedded = Object.fromEntries(langs.map((code, i) => [code, toBase64(data[i])]));
      const parts = [`;(${fetchShim.toString()})(${JSON.stringify(embedded)});\n`, core, '\n;\n', worker];
      return URL.createObjectURL(new Blob(parts, { type: 'text/javascript' }));
    })();
    p.catch(() => blobs.delete(key));
    blobs.set(key, p);
  }
  return blobs.get(key);
}

/**
 * A pool of Tesseract workers for some languages. recognize(image, onProgress)
 * takes a Blob (PNG), runs on the next free worker and resolves words:
 * [{ text, confidence, bbox: [x0,y0,x1,y1], baseline: [x0,y0,x1,y1]|null }]
 * in image pixels. onProgress(0..1) follows that one job.
 */
export async function createOcrEngine(langs, { workers = 2 } = {}) {
  const mod = await import(libUrl('tesseract'));
  const Tesseract = mod.default ?? mod;
  const url = await workerUrl(langs);
  const pool = [];
  for (let i = 0; i < Math.max(1, workers); i++) {
    const slot = { busy: false, onProgress: null, worker: null };
    slot.worker = await Tesseract.createWorker(langs.join('+'), 1 /* LSTM only */, {
      workerPath: url,
      workerBlobURL: false,
      langPath: LANG_PATH,
      cacheMethod: 'none',
      gzip: true,
      logger: (m) => {
        if (m.status === 'recognizing text') slot.onProgress?.(m.progress);
      },
      errorHandler: () => {},
    });
    pool.push(slot);
  }
  const waiting = [];
  const acquire = () => {
    const free = pool.find((s) => !s.busy);
    if (free) {
      free.busy = true;
      return Promise.resolve(free);
    }
    return new Promise((resolve) => waiting.push(resolve));
  };
  const release = (slot) => {
    slot.onProgress = null;
    const next = waiting.shift();
    if (next) next(slot);
    else slot.busy = false;
  };
  let terminated = false;
  return {
    size: pool.length,
    async recognize(image, onProgress) {
      if (terminated) throw new Error('OCR was cancelled');
      const slot = await acquire();
      try {
        if (terminated) throw new Error('OCR was cancelled');
        slot.onProgress = onProgress ?? null;
        const { data } = await slot.worker.recognize(image, {}, { blocks: true, text: false, hocr: false, tsv: false });
        return wordsOf(data);
      } finally {
        release(slot);
      }
    },
    async terminate() {
      if (terminated) return;
      terminated = true;
      await Promise.all(pool.map((s) => s.worker.terminate().catch(() => {})));
      for (const resolve of waiting.splice(0)) resolve(pool[0]);
    },
  };
}

function wordsOf(data) {
  const words = [];
  for (const block of data.blocks ?? []) {
    for (const para of block.paragraphs ?? []) {
      for (const line of para.lines ?? []) {
        for (const w of line.words ?? []) {
          const text = (w.text ?? '').trim();
          if (!text) continue;
          const b = w.bbox;
          const bl = line.baseline ?? w.baseline;
          words.push({
            text,
            confidence: Math.round(w.confidence ?? 0),
            bbox: [b.x0, b.y0, b.x1, b.y1],
            baseline: bl ? [bl.x0, bl.y0, bl.x1, bl.y1] : null,
          });
        }
      }
    }
  }
  return words;
}
