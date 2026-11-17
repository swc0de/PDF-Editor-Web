// Preferences: synchronous reads from localStorage, mirrored to IndexedDB.
//
// localStorage gives synchronous access (the theme is applied before first
// paint). But for file:// pages Chromium doesn't reliably keep it — we've
// seen it come back empty after a reload — so every write is also stored in
// IndexedDB, and loadPrefs() (awaited at startup) restores anything
// localStorage lost. Failures are tolerated everywhere: blocked storage must
// never break the app.
import { idb } from './idb.js';

const PREFIX = 'pdfeditor.';
const memory = new Map(); // fallback when localStorage is unavailable

function readRaw(key) {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (raw !== null) return raw;
  } catch {
    /* unavailable */
  }
  return memory.has(key) ? memory.get(key) : null;
}

function writeRaw(key, raw) {
  memory.set(key, raw);
  try {
    localStorage.setItem(PREFIX + key, raw);
  } catch {
    /* unavailable: memory + IndexedDB still work */
  }
}

/** Restore preferences that localStorage lost from the IndexedDB mirror. */
export async function loadPrefs() {
  try {
    const all = await idb.getAll('prefs');
    for (const { key, raw } of all) {
      if (readRaw(key) === null) writeRaw(key, raw);
    }
  } catch {
    /* no IndexedDB: localStorage only */
  }
}

export function getPref(key, fallback = null) {
  const raw = readRaw(key);
  if (raw === null) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function setPref(key, value) {
  const raw = JSON.stringify(value);
  writeRaw(key, raw);
  idb.put('prefs', { key, raw }).catch(() => {});
}

export function removePref(key) {
  memory.delete(key);
  try {
    localStorage.removeItem(PREFIX + key);
  } catch {
    /* ignore */
  }
  idb.delete('prefs', key).catch(() => {});
}
