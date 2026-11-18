// Single source of truth for third-party library versions.
//
// Every library is loaded from jsDelivr at a pinned version. The end-to-end
// tests read this file too: they serve the same paths from node_modules
// (package.json devDependencies must carry the same versions — the test
// harness fails loudly if they drift).
//
// Keep this file free of imports so Node can import it directly.

export const CDN_BASE = 'https://cdn.jsdelivr.net/npm';

/**
 * OCR languages offered: Latin-script languages whose characters the PDF
 * standard fonts can encode (the invisible text layer uses Helvetica).
 */
export const OCR_LANGUAGES = ['eng', 'deu', 'fra', 'spa', 'ita', 'por', 'nld', 'dan', 'swe', 'nor', 'fin', 'cat'];

export const LIBS = {
  pdfjs: {
    pkg: 'pdfjs-dist',
    version: '6.5.438',
    license: 'Apache-2.0',
    homepage: 'https://mozilla.github.io/pdf.js/',
    files: {
      main: 'build/pdf.min.mjs',
      worker: 'build/pdf.worker.min.mjs',
      cmaps: 'cmaps/',
      standardFonts: 'standard_fonts/',
      wasm: 'wasm/',
      iccs: 'iccs/',
    },
  },
  pdfLib: {
    pkg: 'pdf-lib',
    version: '1.17.1',
    license: 'MIT',
    homepage: 'https://pdf-lib.js.org/',
    files: {
      main: 'dist/pdf-lib.esm.min.js',
      umd: 'dist/pdf-lib.min.js',
    },
  },
  fflate: {
    pkg: 'fflate',
    version: '0.8.3',
    license: 'MIT',
    homepage: 'https://github.com/101arrowz/fflate',
    files: {
      main: 'esm/browser.js',
      umd: 'umd/index.js',
    },
  },
  qpdf: {
    // qpdf 12.2 compiled to WebAssembly (encryption: AES-256 passwords and permissions).
    pkg: '@neslinesli93/qpdf-wasm',
    version: '0.3.1',
    license: 'Apache-2.0 (qpdf) · ISC (WASM build)',
    homepage: 'https://github.com/neslinesli93/qpdf-wasm',
    files: {
      main: 'dist/qpdf.js',
      wasm: 'dist/qpdf.wasm',
    },
  },
  tesseract: {
    pkg: 'tesseract.js',
    version: '7.0.0',
    license: 'Apache-2.0',
    homepage: 'https://tesseract.projectnaptha.com/',
    files: {
      main: 'dist/tesseract.esm.min.js',
      worker: 'dist/worker.min.js',
    },
  },
  tesseractCore: {
    pkg: 'tesseract.js-core',
    version: '7.0.0',
    license: 'Apache-2.0',
    homepage: 'https://github.com/naptha/tesseract.js-core',
    files: {
      // LSTM-only builds with the WebAssembly embedded (no separate .wasm fetch).
      simd: 'tesseract-core-simd-lstm.wasm.js',
      plain: 'tesseract-core-lstm.wasm.js',
    },
  },
  // Trained data, one package per language, downloaded when a language is chosen.
  ...Object.fromEntries(OCR_LANGUAGES.map((code) => [`tessdata_${code}`, {
    pkg: `@tesseract.js-data/${code}`,
    version: '1.0.0',
    license: 'Apache-2.0',
    homepage: 'https://github.com/naptha/tessdata',
    group: 'tessdata',
    files: { main: `4.0.0_best_int/${code}.traineddata.gz` },
  }])),
};

/** Absolute CDN URL for a file of a pinned library. */
export function libUrl(name, file = 'main') {
  const lib = LIBS[name];
  if (!lib) throw new Error(`Unknown library: ${name}`);
  const path = lib.files[file] ?? file;
  return `${CDN_BASE}/${lib.pkg}@${lib.version}/${path}`;
}
