// Tiny i18n layer. Every user-facing string lives in a locale table
// (English only for now). Use t('key') or t('key', { n: 3 }).
import { en } from './en.js';

const locales = { en };
let current = en;

export function setLocale(code) {
  current = locales[code] ?? en;
  document.documentElement.lang = locales[code] ? code : 'en';
}

export function t(key, params) {
  let s = current[key] ?? en[key];
  if (s === undefined) {
    console.warn(`[i18n] missing string: ${key}`);
    return key;
  }
  if (params) {
    s = s.replace(/\{(\w+)\}/g, (m, name) => (name in params ? String(params[name]) : m));
  }
  return s;
}

/** True if a key exists (used by tests and the registry). */
export function hasString(key) {
  return key in current || key in en;
}

/** Plural-aware: uses `${key}.one` when n === 1, else `${key}.other`. */
export function tn(key, n, params = {}) {
  return t(`${key}.${n === 1 ? 'one' : 'other'}`, { n, ...params });
}
