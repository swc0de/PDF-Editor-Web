// qpdf (WebAssembly) for encryption: each run happens in a fresh classic Blob
// worker. qpdf.js and qpdf.wasm are downloaded once on the main thread (so the
// worker needs no network) and loaded lazily, only when a protect tool runs.
import { libUrl } from './libs.config.js';

let assets = null;

function loadAssets() {
  if (!assets) {
    assets = Promise.all([
      fetch(libUrl('qpdf', 'main')).then((r) => {
        if (!r.ok) throw new Error(`qpdf download failed (${r.status})`);
        return r.text();
      }),
      fetch(libUrl('qpdf', 'wasm')).then((r) => {
        if (!r.ok) throw new Error(`qpdf download failed (${r.status})`);
        return r.arrayBuffer();
      }),
    ]).then(([js, wasm]) => ({
      url: URL.createObjectURL(new Blob([js, `\n;(${qpdfWorkerMain.toString()})();`], { type: 'text/javascript' })),
      wasm,
    }));
    assets.catch(() => {
      assets = null;
    });
  }
  return assets;
}

/** Runs inside the worker (after qpdf.js has defined the global `Module` factory). */
function qpdfWorkerMain() {
  self.onmessage = async (e) => {
    const { wasm, args, files, outputs } = e.data;
    // This build has no wasmBinary option, but asks locateFile() where qpdf.wasm
    // is: a Blob URL made here (one made on the page isn't readable from a
    // worker under file://).
    const wasmUrl = URL.createObjectURL(new Blob([wasm], { type: 'application/wasm' }));
    const stdout = [];
    const stderr = [];
    // This build writes straight to the console (it ignores print/printErr):
    // capture it, before qpdf binds to it.
    console.log = (...a) => stdout.push(a.join(' '));
    console.info = console.log;
    console.error = (...a) => stderr.push(a.join(' '));
    console.warn = console.error;
    try {
      // eslint-disable-next-line no-undef
      const qpdf = await Module({ locateFile: () => wasmUrl, noInitialRun: true });
      for (const [name, bytes] of Object.entries(files)) qpdf.FS.writeFile(name, bytes);
      let code = 0;
      try {
        code = qpdf.callMain(args);
      } catch (err) {
        if (err && typeof err.status === 'number') code = err.status;
        else throw err;
      }
      const out = {};
      for (const name of outputs) {
        try {
          out[name] = qpdf.FS.readFile(name);
        } catch {
          /* not written */
        }
      }
      self.postMessage({ code, stdout: stdout.join('\n'), stderr: stderr.join('\n'), files: out }, Object.values(out).map((b) => b.buffer));
    } catch (err) {
      self.postMessage({ code: -1, stdout: stdout.join('\n'), stderr: `${stderr.join('\n')}\n${err && err.message ? err.message : err}`, files: {} });
    }
  };
}

/**
 * Run qpdf with arguments; `files` are written to its in-memory file system
 * first and `outputs` read back. Resolves { code, stdout, stderr, files }.
 * Exit codes: 0 ok, 3 ok with warnings, 2 error.
 */
export async function runQpdf(args, { files = {}, outputs = [] } = {}) {
  const { url, wasm } = await loadAssets();
  const worker = new Worker(url);
  try {
    return await new Promise((resolve, reject) => {
      worker.onmessage = (e) => resolve(e.data);
      worker.onerror = (e) => reject(new Error(e.message || 'qpdf worker failed'));
      const copies = Object.fromEntries(Object.entries(files).map(([n, b]) => [n, b.slice()]));
      worker.postMessage({ wasm, args, files: copies, outputs }, [...Object.values(copies).map((b) => b.buffer)]);
    });
  } finally {
    worker.terminate();
  }
}

/** Permissions a protected file grants (each true = allowed). */
export const PERMISSION_KEYS = ['print', 'copy', 'edit', 'comment', 'fillForms', 'assemble'];

/** Encrypt with AES-256. Resolves the protected bytes. */
export async function encryptPdf(bytes, { userPassword = '', ownerPassword = '', permissions = {} }) {
  const yn = (v) => (v === false ? 'n' : 'y');
  const args = ['/in.pdf', '--encrypt', `--user-password=${userPassword}`, `--owner-password=${ownerPassword}`, '--bits=256',
    `--print=${permissions.print === false ? 'none' : 'full'}`,
    `--extract=${yn(permissions.copy)}`,
    `--modify-other=${yn(permissions.edit)}`,
    `--annotate=${yn(permissions.comment)}`,
    `--form=${yn(permissions.fillForms)}`,
    `--assemble=${yn(permissions.assemble)}`,
    '--', '/out.pdf'];
  const r = await runQpdf(args, { files: { '/in.pdf': bytes }, outputs: ['/out.pdf'] });
  if ((r.code !== 0 && r.code !== 3) || !r.files['/out.pdf']) throw new Error(r.stderr || `qpdf failed (${r.code})`);
  return r.files['/out.pdf'];
}

/** Which password was supplied: 'owner', 'user' or null (wrong / none needed). Also the encryption summary. */
export async function checkPassword(bytes, password) {
  const r = await runQpdf(['--show-encryption', `--password=${password}`, '/in.pdf'], { files: { '/in.pdf': bytes } });
  const text = `${r.stdout}\n${r.stderr}`;
  const kind = /Supplied password is owner password/i.test(text) ? 'owner' : /Supplied password is user password/i.test(text) ? 'user' : null;
  return { kind, encrypted: !/File is not encrypted/i.test(text), info: r.stdout };
}

/** Remove encryption (needs the owner password, or the user password if they're the same). */
export async function decryptPdf(bytes, password) {
  const r = await runQpdf([`--password=${password}`, '--decrypt', '/in.pdf', '/out.pdf'], { files: { '/in.pdf': bytes }, outputs: ['/out.pdf'] });
  if ((r.code !== 0 && r.code !== 3) || !r.files['/out.pdf']) throw new Error(r.stderr || `qpdf failed (${r.code})`);
  return r.files['/out.pdf'];
}
