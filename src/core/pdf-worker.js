// Client for the pdf-lib worker. The worker is a classic worker started from
// a Blob URL that contains pdf-lib's UMD build followed by our worker code
// (module workers from Blob URLs don't work on file:// pages). pdf-lib is
// downloaded on the main thread, so it's fetched once and failures surface
// here.
import { libUrl } from './libs.config.js';
import { workerMain } from './worker/worker-main.js';
import { opsSource } from './ops/index.js';

let workerPromise = null;
let seq = 0;
const pending = new Map();

export class WorkerOpError extends Error {
  constructor({ name, message }) {
    super(message);
    this.name = name || 'WorkerOpError';
  }
}

async function startWorker() {
  const res = await fetch(libUrl('pdfLib', 'umd'));
  if (!res.ok) throw new Error(`pdf-lib download failed (${res.status})`);
  const lib = await res.text();
  const source = `${lib}\n;(${workerMain.toString()})(${opsSource()});\n`;
  const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
  const worker = new Worker(url, { name: 'pdf-lib' });
  worker.onmessage = (e) => {
    const p = pending.get(e.data.id);
    if (!p) return;
    pending.delete(e.data.id);
    p.resolve(e.data);
  };
  worker.onerror = (e) => {
    const err = new Error(`pdf-lib worker failed: ${e.message || 'unknown error'}`);
    for (const p of pending.values()) p.reject(err);
    pending.clear();
    workerPromise = null;
  };
  return worker;
}

function getWorker() {
  if (!workerPromise) {
    workerPromise = startWorker().catch((err) => {
      workerPromise = null;
      throw err;
    });
  }
  return workerPromise;
}

/** Send a message; resolves with the raw reply. */
export async function callWorker(message, transfer = []) {
  const worker = await getWorker();
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker.postMessage({ ...message, id }, transfer);
  });
}

/**
 * Run an op on a document. `getBytes()` is only called if the worker doesn't
 * already hold this document at `version`.
 */
export async function applyOp({ docId, version, newVersion, op, args, getBytes }) {
  let reply = await callWorker({ type: 'apply', docId, version, newVersion, op, args });
  if (reply.needBytes) {
    const buffer = getBytes().slice().buffer; // keep our copy; transfer the clone
    reply = await callWorker({ type: 'apply', docId, version, newVersion, op, args, bytes: buffer }, [buffer]);
  }
  if (!reply.ok) throw new WorkerOpError(reply.error ?? { message: 'operation failed' });
  return { bytes: new Uint8Array(reply.bytes), pageCount: reply.pageCount, affected: reply.affected, value: reply.value };
}

/** Run a read-only op (e.g. exportPages) against the document at `version`. */
export async function runQuery({ docId, version, op, args, getBytes }) {
  let reply = await callWorker({ type: 'run', docId, version, op, args });
  if (reply.needBytes) {
    const buffer = getBytes().slice().buffer;
    reply = await callWorker({ type: 'run', docId, version, op, args, bytes: buffer }, [buffer]);
  }
  if (!reply.ok) throw new WorkerOpError(reply.error ?? { message: 'operation failed' });
  return reply.value;
}

export function closeWorkerDoc(docId) {
  if (workerPromise) callWorker({ type: 'close', docId }).catch(() => {});
}
