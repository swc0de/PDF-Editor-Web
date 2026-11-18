// Lazy loaders for the CDN libraries. Each library is fetched at most once.
import { libUrl } from './libs.config.js';

const cache = new Map();

function once(key, loader) {
  if (!cache.has(key)) {
    const p = loader().catch((err) => {
      cache.delete(key); // allow a retry after a network failure
      throw err;
    });
    cache.set(key, p);
  }
  return cache.get(key);
}

/** pdf.js main module (the worker is wired up by the viewer, see view/). */
export function loadPdfjs() {
  return once('pdfjs', () => import(libUrl('pdfjs')));
}

/** pdf-lib ES module (main thread use; heavy work runs in a worker later). */
export function loadPdfLib() {
  return once('pdfLib', () => import(libUrl('pdfLib')));
}

/** fflate for zipping split outputs. */
export function loadFflate() {
  return once('fflate', () => import(libUrl('fflate')));
}
