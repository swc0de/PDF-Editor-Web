// No hard-coded user-facing strings in the UI code: text, titles, labels,
// placeholders, alt text and toasts must come from src/i18n (t / tn).
import { test, expect } from '@playwright/test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('../../src/', import.meta.url).pathname;
const DIRS = ['ui', 'view', 'tools'];
// Symbols that aren't words in any language (the find toggles' "match case" / "whole word" glyphs).
const ALLOWED = new Set(['Aa', 'ab']);

function files(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? files(p) : p.endsWith('.js') ? [p] : [];
  });
}

const RULES = [
  // UI properties set to a literal with letters.
  { name: 'property', re: /(?:textContent|innerText|title|placeholder|'aria-label'|"aria-label"|alt|label)\s*[:=]\s*(['"`])([^'"`]*[A-Za-z]{2,}[^'"`]*)\1/g, group: 2 },
  // h('tag', …, 'Some text') — a literal text child.
  { name: 'h() text', re: /h\('[^']*'(?:,\s*\{[^{}]*\})?,\s*(['"])([^'"]*[A-Za-z]{2,}[^'"]*)\1\s*\)/g, group: 2 },
  // toast('…') / dialogs with literal text.
  { name: 'toast', re: /toast\(\s*(['"`])([^'"`]*[A-Za-z]{2,}[^'"`]*)\1/g, group: 2 },
  { name: 'dialog text', re: /(?:message|title)\s*:\s*(['"`])([^'"`]*\s[^'"`]*)\1/g, group: 2 },
];

function scan(src, file = 'sample.js') {
  const problems = [];
  for (const { name, re, group } of RULES) {
    for (const m of src.matchAll(re)) {
      const text = m[group];
      if (ALLOWED.has(text)) continue;
      // Template parts are variables; what's left must not be words.
      const literal = text.replace(/\$\{[^}]*\}/g, '');
      if (!/[A-Za-z]{2,}/.test(literal)) continue;
      // i18n keys (possibly built with variables), e.g. `command.panel.${id}`.
      if (/^[a-z][\w-]*(?:\.[\w${}-]+)+$/.test(text)) continue;
      // Identifiers, CSS classes and URLs aren't prose.
      if (/^[\w.-]+$/.test(text) && !/^[A-Z][a-z]+$/.test(text)) continue;
      if (/^(?:https?:|#|\.|\/)/.test(text)) continue;
      const line = src.slice(0, m.index).split('\n').length;
      problems.push(`${file}:${line} [${name}] ${JSON.stringify(text)}`);
    }
  }
  return problems;
}

test('UI code has no hard-coded user-facing strings', () => {
  const problems = [];
  for (const dir of DIRS) {
    for (const file of files(join(ROOT, dir))) problems.push(...scan(readFileSync(file, 'utf8'), file.slice(ROOT.length)));
  }
  expect(problems).toEqual([]);
});

test('the scan catches hard-coded text', () => {
  const bad = [
    "el.textContent = 'Saving your file';",
    "h('button.btn', { type: 'button' }, 'Delete page')",
    "toast(`Saved ${name}`)",
    "h('input', { placeholder: 'Search tools' })",
    "confirmDialog({ title: 'Are you sure?' })",
  ];
  for (const line of bad) expect(scan(line).length, line).toBeGreaterThan(0);
  expect(scan("h('span', t('find.none')); el.title = `${pct}%`; label: `command.panel.${id}`")).toEqual([]);
});
