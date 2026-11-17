// Preferences in localStorage, namespaced and failure-tolerant
// (private windows or blocked storage must never break the app).
const PREFIX = 'pdfeditor.';

export function getPref(key, fallback = null) {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw === null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function setPref(key, value) {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    /* storage unavailable: keep working without persistence */
  }
}

export function removePref(key) {
  try {
    localStorage.removeItem(PREFIX + key);
  } catch {
    /* ignore */
  }
}
