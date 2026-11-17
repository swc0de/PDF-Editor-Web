// User preferences (Preferences dialog) and the window arrangement (panel
// sizes/visibility), persisted in localStorage via prefs.js.
import { getPref, setPref, removePref } from './prefs.js';

export const SETTING_DEFAULTS = {
  toolsSide: 'left', // 'left' | 'right'
  author: '', // name used on comments
  defaultZoom: 'auto', // 'auto' | 'fit-width' | 'fit-page' | number
  defaultLayout: 'continuous', // 'continuous' | 'single' | 'two-up' | 'two-up-cover'
};

export const ARRANGEMENT_DEFAULTS = {
  tools: { visible: true, width: 260 },
  side: { visible: false, width: 320, panel: 'pages' },
};

export const TOOLS_WIDTH = { min: 240, max: 520 };
export const SIDE_WIDTH = { min: 260, max: 520 };

const listeners = new Set();
export function onSettingsChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
const emit = (key) => listeners.forEach((fn) => fn(key));

export function getSetting(key) {
  return getPref(`setting.${key}`, SETTING_DEFAULTS[key]);
}

export function setSetting(key, value) {
  if (value === SETTING_DEFAULTS[key]) removePref(`setting.${key}`);
  else setPref(`setting.${key}`, value);
  emit(key);
}

export function getArrangement() {
  const saved = getPref('arrangement', null) ?? {};
  const clamp = (v, { min, max }, d) => (Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : d);
  const tools = { ...ARRANGEMENT_DEFAULTS.tools, ...saved.tools };
  const side = { ...ARRANGEMENT_DEFAULTS.side, ...saved.side };
  tools.width = clamp(tools.width, TOOLS_WIDTH, ARRANGEMENT_DEFAULTS.tools.width);
  side.width = clamp(side.width, SIDE_WIDTH, ARRANGEMENT_DEFAULTS.side.width);
  return { tools, side };
}

export function saveArrangement(arrangement) {
  setPref('arrangement', arrangement);
  emit('arrangement');
}

export function resetArrangement() {
  removePref('arrangement');
  emit('arrangement');
  return getArrangement();
}

/** The author name for comments (falls back to "Anonymous" in the UI). */
export function authorName() {
  return getSetting('author').trim();
}
