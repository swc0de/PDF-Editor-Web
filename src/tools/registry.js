// Central tool registry.
//
// Every tool is *defined* up front in catalogue.js (metadata, status "soon")
// so the catalogue is complete from day one. A tool's own module later calls
// implementTool(id, run) which flips its status to "ready". The UI (tools
// panel, home catalogue, command palette) reads only from this registry.

export const CATEGORIES = [
  'read',
  'find',
  'organize',
  'combine',
  'protect',
  'forms',
  'ocr',
  'everywhere',
];

const tools = new Map();
const listeners = new Set();

/**
 * @typedef {Object} ToolDef
 * @property {string} id          kebab-case id, unique
 * @property {string} label       i18n key for the visible name
 * @property {string} description i18n key for the one-line description
 * @property {string} category    one of CATEGORIES
 * @property {string} icon        icon name from ui/icons.js
 * @property {string} [shortcut]  e.g. "Mod+F" (Mod = ⌘ on macOS, Ctrl elsewhere)
 * @property {string} milestone   the milestone that builds it, e.g. "M5"
 * @property {'ready'|'soon'} status
 * @property {(ctx: object) => any} [run]
 */

export function defineTool(def) {
  if (!/^[a-z][a-z0-9-]*$/.test(def.id)) throw new Error(`Bad tool id: ${def.id}`);
  if (tools.has(def.id)) throw new Error(`Tool defined twice: ${def.id}`);
  if (!CATEGORIES.includes(def.category)) {
    throw new Error(`Tool ${def.id} has unknown category: ${def.category}`);
  }
  const tool = {
    label: `tool.${def.id}.label`,
    description: `tool.${def.id}.desc`,
    shortcut: null,
    ...def,
    status: 'soon',
    run: null,
  };
  tools.set(tool.id, tool);
  emit();
  return tool;
}

/** Called by a tool's own module once it is built. */
export function implementTool(id, run) {
  const tool = tools.get(id);
  if (!tool) throw new Error(`implementTool: unknown tool ${id}`);
  if (typeof run !== 'function') throw new Error(`implementTool: ${id} needs a run()`);
  tool.run = run;
  tool.status = 'ready';
  emit();
  return tool;
}

export function getTool(id) {
  return tools.get(id) ?? null;
}

export function listTools({ category, status } = {}) {
  return [...tools.values()].filter(
    (t) => (!category || t.category === category) && (!status || t.status === status),
  );
}

export function toolsByCategory() {
  return CATEGORIES.map((category) => ({ category, tools: listTools({ category }) }));
}

/** Run a tool. Tools that aren't built yet are refused, never faked. */
export async function runTool(id, ctx = {}) {
  const tool = tools.get(id);
  if (!tool) throw new Error(`Unknown tool: ${id}`);
  if (tool.status !== 'ready') return { ok: false, reason: 'soon' };
  return { ok: true, value: await tool.run(ctx) };
}

export function onRegistryChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit() {
  for (const fn of listeners) fn();
}
