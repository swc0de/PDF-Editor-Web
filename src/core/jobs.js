// Run a long job (combine / split / extract) in its own disposable worker.
// Progress is reported as it goes; cancel() terminates the worker at once,
// without disturbing the editing worker.
import { workerUrl } from './worker-source.js';

export class JobCancelled extends Error {
  constructor() {
    super('Cancelled');
    this.name = 'JobCancelled';
  }
}

/**
 * @param {string} job   name in core/ops/jobs.js
 * @param {object} args
 * @param {{ onProgress?: (p: {done:number,total:number,label:string}) => void, transfer?: ArrayBuffer[] }} [o]
 * @returns {{ promise: Promise<any>, cancel: () => void }}
 */
export function runJob(job, args, { onProgress, transfer = [] } = {}) {
  let worker = null;
  let settled = false;
  let rejectFn;
  const promise = new Promise((resolve, reject) => {
    rejectFn = reject;
    workerUrl({ zip: true }).then((url) => {
      if (settled) return;
      worker = new Worker(url, { name: `job-${job}` });
      URL.revokeObjectURL(url);
      worker.onmessage = (e) => {
        const msg = e.data;
        if (msg.progress) {
          onProgress?.(msg.progress);
          return;
        }
        settled = true;
        worker.terminate();
        if (msg.ok) resolve(msg.value);
        else {
          const err = new Error(msg.error?.message ?? 'Job failed');
          err.name = msg.error?.name ?? 'JobError';
          reject(err);
        }
      };
      worker.onerror = (e) => {
        if (settled) return;
        settled = true;
        worker.terminate();
        reject(new Error(e.message || 'Job worker failed'));
      };
      worker.postMessage({ id: 1, type: 'job', job, args }, transfer);
    }, (err) => {
      settled = true;
      reject(err);
    });
  });
  return {
    promise,
    cancel() {
      if (settled) return;
      settled = true;
      worker?.terminate();
      rejectFn(new JobCancelled());
    },
  };
}
