// Every operation the pdf-lib worker can run, by name. Later milestones add
// more op modules here.
import * as pageOps from './page-ops.js';

export const OPS = { ...pageOps };

/** JavaScript source of an object literal holding every op function. */
export function opsSource() {
  return `{${Object.entries(OPS).map(([name, fn]) => `${JSON.stringify(name)}: (${fn.toString()})`).join(',\n')}}`;
}
