// pdf.js setup: the library, its worker (from a Blob URL so the single file
// works from file://) and document opening with the password flow.
import { loadPdfjs } from '../core/libs.js';
import { libUrl } from '../core/libs.config.js';

let ready = null;

// All documents share one pdf.js worker port. pdf.js refuses to open a
// document while another's destroy() is still pending on that port, so every
// destroy goes through destroyPdf() and openPdf() waits for them first.
const pendingDestroys = new Set();

/** Close a pdf.js document (or loading task) safely. */
export function destroyPdf(docOrTask) {
  const task = docOrTask?.loadingTask ?? docOrTask;
  if (!task?.destroy) return Promise.resolve();
  const p = task.destroy().catch(() => {}).finally(() => pendingDestroys.delete(p));
  pendingDestroys.add(p);
  return p;
}

/** Resolves once no document is being destroyed. */
export async function pdfjsIdle() {
  while (pendingDestroys.size) await Promise.all([...pendingDestroys]);
}

/** Load pdf.js once and wire up a module worker created from a Blob URL. */
export function getPdfjs() {
  if (!ready) {
    ready = (async () => {
      const pdfjs = await loadPdfjs();
      if (!pdfjs.GlobalWorkerOptions.workerPort) {
        pdfjs.GlobalWorkerOptions.workerPort = await createPdfWorker();
      }
      return pdfjs;
    })().catch((err) => {
      ready = null;
      throw err;
    });
  }
  return ready;
}

/**
 * Start pdf.js's worker from a Blob URL.
 *
 * Workers must be same-origin, so we download the worker's code on the main
 * thread and run it from a Blob URL. It has to be a *classic* worker: Chrome
 * refuses module workers from Blob URLs when the page is a file:// URL
 * (opaque origin). pdf.worker.min.mjs is an ES module, but its only module
 * syntax is a trailing `export {…}` (used just for pdf.js's fake-worker mode)
 * and `import.meta.url` (a base URL inside its wasm decoders), so we strip /
 * substitute those and keep strict mode. The worker starts itself on load.
 */
async function createPdfWorker() {
  const workerUrl = libUrl('pdfjs', 'worker');
  const res = await fetch(workerUrl);
  if (!res.ok) throw new Error(`pdf.js worker download failed (${res.status})`);
  let code = await res.text();
  code = code
    .replace(/import\.meta\.url/g, JSON.stringify(workerUrl))
    .replace(/export\s*\{[^}]*\}\s*;?\s*(\/\/[^\n]*)?\s*$/, '');
  if (/import\.meta|\bexport\s*\{/.test(code.slice(-500)) || code.includes('import.meta')) {
    throw new Error('Unexpected pdf.js worker format');
  }
  const url = URL.createObjectURL(new Blob(['"use strict";\n', code], { type: 'text/javascript' }));
  return new Worker(url, { name: 'pdfjs' });
}

export class PasswordCancelled extends Error {
  constructor() {
    super('Password entry was cancelled');
    this.name = 'PasswordCancelled';
  }
}

/**
 * Open PDF bytes with pdf.js.
 * @param {Uint8Array} bytes  not detached: a copy is handed to the worker
 * @param {object} options
 * @param {(retry: boolean) => Promise<string|null>} options.askPassword
 * @param {(fraction: number) => void} [options.onProgress]
 * @returns {Promise<{ doc: object, password: string|null }>}
 */
export async function openPdf(bytes, { askPassword, onProgress, password: initialPassword = null } = {}) {
  const pdfjs = await getPdfjs();
  await pdfjsIdle();
  const task = pdfjs.getDocument({
    data: bytes.slice(), // pdf.js transfers (detaches) the buffer it gets
    password: initialPassword ?? undefined,
    cMapUrl: libUrl('pdfjs', 'cmaps'),
    cMapPacked: true,
    standardFontDataUrl: libUrl('pdfjs', 'standardFonts'),
    wasmUrl: libUrl('pdfjs', 'wasm'),
    iccUrl: libUrl('pdfjs', 'iccs'),
    // Fonts, CMaps and wasm are fetched on the main thread and handed over.
    useWorkerFetch: false,
    isEvalSupported: false,
    enableXfa: false,
    disableWorkerRendering: true,
    verbosity: pdfjs.VerbosityLevel.ERRORS,
  });

  let password = initialPassword;
  let cancelled = false;
  task.onPassword = async (updatePassword, reason) => {
    const retry = reason === pdfjs.PasswordResponses.INCORRECT_PASSWORD;
    const entered = askPassword ? await askPassword(retry) : null;
    if (entered === null || entered === undefined) {
      cancelled = true;
      destroyPdf(task);
      return;
    }
    password = entered;
    updatePassword(entered);
  };
  if (onProgress) {
    task.onProgress = ({ loaded, total }) => total && onProgress(Math.min(1, loaded / total));
  }

  try {
    const doc = await task.promise;
    return { doc, password };
  } catch (err) {
    if (cancelled) throw new PasswordCancelled();
    throw err;
  }
}

/** Is this error "the user typed nothing and cancelled"? */
export function isPasswordCancel(err) {
  return err instanceof PasswordCancelled;
}
