// Every operation the pdf-lib worker can run, by name. Later milestones add
// more op modules here.
import * as pageOps from './page-ops.js';
import * as infoOps from './info-ops.js';
import * as annotOps from './annot-ops.js';
import * as annotHelpers from './annot-helpers.js';
import * as helpers from './pdf-helpers.js';
import * as jobs from './jobs.js';

export const OPS = { ...pageOps, ...infoOps, ...annotOps };
export const HELPERS = { ...helpers, ...annotHelpers };
export const JOBS = { ...jobs };

const literal = (table) => `{${Object.entries(table).map(([name, fn]) => `${JSON.stringify(name)}: (${fn.toString()})`).join(',\n')}}`;

/** JavaScript source of object literals holding every op, helper and job. */
export function opsSource() {
  return literal(OPS);
}
export function helpersSource() {
  return literal(HELPERS);
}
export function jobsSource() {
  return literal(JOBS);
}
