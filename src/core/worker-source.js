// Builds the source of our classic Blob workers: pdf-lib's UMD build (and
// fflate's, for job workers) followed by the worker code. Library code is
// downloaded once on the main thread and reused for every worker.
import { libUrl } from './libs.config.js';
import { workerMain } from './worker/worker-main.js';
import { opsSource, helpersSource, jobsSource } from './ops/index.js';

const texts = new Map();

function libText(name, file) {
  const key = `${name}:${file}`;
  if (!texts.has(key)) {
    const p = fetch(libUrl(name, file)).then((res) => {
      if (!res.ok) throw new Error(`${name} download failed (${res.status})`);
      return res.text();
    });
    p.catch(() => texts.delete(key));
    texts.set(key, p);
  }
  return texts.get(key);
}

/** A Blob URL for a worker. `zip: true` also bundles fflate (job workers). */
export async function workerUrl({ zip = false } = {}) {
  const parts = [await libText('pdfLib', 'umd')];
  if (zip) parts.push(await libText('fflate', 'umd'));
  parts.push(`;(${workerMain.toString()})(${opsSource()}, ${helpersSource()}, ${jobsSource()});`);
  return URL.createObjectURL(new Blob([parts.join('\n')], { type: 'text/javascript' }));
}
