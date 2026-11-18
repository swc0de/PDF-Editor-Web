// Every literal i18n key used in src/ must exist in the English table, and
// panel/tool/category keys built from ids must exist for every id.
import { test, expect } from '@playwright/test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '../../src');
const { en } = await import(join(SRC, 'i18n/en.js'));

function walk(dir) {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.js') ? [p] : [];
  });
}

test('every literal t("key") exists', () => {
  const missing = [];
  for (const file of walk(SRC).filter((f) => !f.includes('/i18n/'))) {
    const code = readFileSync(file, 'utf8');
    for (const m of code.matchAll(/\bt\(\s*'([a-zA-Z0-9_.-]+)'/g)) {
      if (!(m[1] in en)) missing.push(`${m[1]}  (${file.slice(SRC.length + 1)})`);
    }
    for (const m of code.matchAll(/\blabel:\s*'([a-z][a-zA-Z0-9_.-]+\.[a-zA-Z0-9_.-]+)'/g)) {
      if (!(m[1] in en)) missing.push(`${m[1]}  (${file.slice(SRC.length + 1)})`);
    }
  }
  expect(missing).toEqual([]);
});

test('keys derived from ids exist (tools, categories, panels)', async () => {
  const { CATEGORIES } = await import(join(SRC, 'tools/registry.js'));
  const catalogue = readFileSync(join(SRC, 'tools/catalogue.js'), 'utf8');
  const toolIds = [...catalogue.matchAll(/\{ id: '([a-z-]+)'/g)].map((m) => m[1]);
  const panels = readFileSync(join(SRC, 'ui/panels.js'), 'utf8');
  const panelIds = [...panels.matchAll(/\{ id: '([a-z-]+)'/g)].map((m) => m[1]);
  const need = [
    ...CATEGORIES.map((c) => `category.${c}`),
    ...toolIds.flatMap((id) => [`tool.${id}.label`, `tool.${id}.desc`]),
    ...panelIds.flatMap((id) => [`panel.${id}.label`, `panel.${id}.noDocument`, `command.panel.${id}`]),
  ];
  expect(need.filter((k) => !(k in en))).toEqual([]);
});
