// The body of the pdf-lib worker. Serialised with toString() and run as a
// classic worker (see core/pdf-worker.js), after pdf-lib's UMD build has
// defined self.PDFLib. Must be self-contained.
//
// Protocol (main → worker):
//   { id, type: 'apply', docId, version, newVersion, bytes?, op, args }
//     Loads `bytes` if given, otherwise reuses the cached pdf-lib document,
//     which must be at `version` (else replies { needBytes: true }). Runs the
//     op, saves, and replies { bytes, pageCount, affected, value }.
//   { id, type: 'run', ... }       same, but read-only: no save; replies { value }
//   { id, type: 'close', docId }   forget a document
//   { id, type: 'job', job, args } run a long job (core/ops/jobs.js); posts
//     { id, progress: { done, total, label } } along the way, then the result.
//     Job workers are disposable: cancelling = terminating the worker.
// Replies: { id, ok: true, ... } or { id, ok: false, error | needBytes }.

export function workerMain(OPS, HELPERS, JOBS) {
  const L = self.PDFLib;

  // Collect the ArrayBuffers of every Uint8Array in a result, to transfer them.
  const buffersIn = (value, out = []) => {
    if (value instanceof Uint8Array) out.push(value.buffer);
    else if (value && typeof value === 'object') for (const v of Object.values(value)) buffersIn(v, out);
    return out;
  };
  const docs = new Map(); // docId → { version, doc }

  const reply = (msg, transfer) => self.postMessage(msg, transfer || []);

  self.onmessage = async (event) => {
    const msg = event.data;
    const { id, type, docId } = msg;
    try {
      if (type === 'close') {
        docs.delete(docId);
        reply({ id, ok: true });
        return;
      }
      if (type === 'job') {
        const job = JOBS[msg.job];
        if (!job) throw new Error(`Unknown job ${msg.job}`);
        const ctx = {
          helpers: HELPERS,
          progress: (done, total, label) => self.postMessage({ id, progress: { done, total, label } }),
          zip: (files) => self.fflate.zipSync(Object.fromEntries(Object.entries(files).map(([n, b]) => [n, [b, { level: 0 }]]))),
        };
        const value = await job(L, msg.args || {}, ctx);
        reply({ id, ok: true, value }, buffersIn(value));
        return;
      }
      if (type !== 'apply' && type !== 'run') throw new Error(`Unknown message ${type}`);

      let entry = docs.get(docId);
      if (msg.bytes) {
        const doc = await L.PDFDocument.load(new Uint8Array(msg.bytes), { updateMetadata: false });
        entry = { version: msg.version, doc };
        docs.set(docId, entry);
      }
      if (!entry || entry.version !== msg.version) {
        reply({ id, ok: false, needBytes: true });
        return;
      }
      const fn = OPS[msg.op];
      if (!fn) throw new Error(`Unknown operation ${msg.op}`);
      // pdf-lib's removePage() doesn't invalidate its page cache (insertPage
      // does), so a document kept across edits could hand out stale pages.
      const freshPages = () => { try { entry.doc.pageCache.invalidate(); } catch (e) { /* older pdf-lib */ } };
      freshPages();
      const result = (await fn(L, entry.doc, msg.args || {}, { helpers: HELPERS })) || {};
      freshPages();
      if (type === 'run') {
        // Read-only query: no save, no new version. Byte results are transferred.
        const value = result.value;
        const transfer = value && value.bytes instanceof Uint8Array ? [value.bytes.buffer] : [];
        reply({ id, ok: true, value }, transfer);
        return;
      }
      const saved = await entry.doc.save();
      entry.version = msg.newVersion;
      const buffer = saved.byteOffset === 0 && saved.byteLength === saved.buffer.byteLength
        ? saved.buffer
        : saved.slice().buffer;
      reply({
        id,
        ok: true,
        bytes: buffer,
        pageCount: entry.doc.getPageCount(),
        affected: Array.isArray(result.affected) ? result.affected : null,
        value: result.value,
      }, [buffer]);
    } catch (err) {
      // A failed op may have half-modified the cached document: drop it.
      docs.delete(docId);
      reply({ id, ok: false, error: { name: err && err.name, message: String((err && err.message) || err) } });
    }
  };
}
