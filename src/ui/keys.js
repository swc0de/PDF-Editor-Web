// Keyboard shortcut helpers. Shortcuts are written as "Mod+Shift+S":
// Mod is ⌘ on macOS and Ctrl elsewhere.

export const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

const MAC_SYMBOLS = { Mod: '⌘', Shift: '⇧', Alt: '⌥', Ctrl: '⌃' };
const KEY_NAMES = { Escape: 'Esc', ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓' };

// "=" and "-" are typed with or without Shift depending on the layout (and
// the numpad sends "+"/"-"), so for these Shift is ignored.
const SHIFT_AGNOSTIC = { '=': ['=', '+'], '-': ['-', '_'] };

/** Human-readable shortcut for the current platform, e.g. "⌘F" or "Ctrl+F". */
export function formatShortcut(shortcut) {
  if (!shortcut) return '';
  const parts = shortcut.split('+');
  const key = KEY_NAMES[parts.at(-1)] ?? parts.at(-1);
  if (IS_MAC) {
    const order = ['Ctrl', 'Alt', 'Shift', 'Mod'];
    const mods = parts.slice(0, -1).sort((a, b) => order.indexOf(a) - order.indexOf(b));
    return mods.map((m) => MAC_SYMBOLS[m] ?? m).join('') + key;
  }
  return [...parts.slice(0, -1).map((p) => (p === 'Mod' ? 'Ctrl' : p)), key].join('+');
}

/** Does a KeyboardEvent match a shortcut string? */
export function matchShortcut(event, shortcut) {
  const parts = shortcut.split('+');
  const key = parts.at(-1);
  const want = new Set(parts.slice(0, -1));
  const mod = IS_MAC ? event.metaKey : event.ctrlKey;
  if (want.has('Mod') !== mod) return false;
  if (want.has('Alt') !== event.altKey) return false;
  if (IS_MAC && want.has('Ctrl') !== event.ctrlKey) return false;
  const agnostic = SHIFT_AGNOSTIC[key];
  if (agnostic) return agnostic.includes(event.key);
  if (want.has('Shift') !== event.shiftKey) return false;
  return event.key.toLowerCase() === key.toLowerCase();
}
