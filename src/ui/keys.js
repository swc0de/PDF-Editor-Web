// Keyboard shortcut helpers. Shortcuts are written as "Mod+Shift+S":
// Mod is ⌘ on macOS and Ctrl elsewhere.

export const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

const MAC_SYMBOLS = { Mod: '⌘', Shift: '⇧', Alt: '⌥', Ctrl: '⌃' };

/** Human-readable shortcut for the current platform, e.g. "⌘F" or "Ctrl+F". */
export function formatShortcut(shortcut) {
  if (!shortcut) return '';
  const parts = shortcut.split('+');
  if (IS_MAC) {
    // macOS convention: modifiers in the order ⌃⌥⇧⌘, no separators.
    const order = ['Ctrl', 'Alt', 'Shift', 'Mod'];
    const mods = parts.slice(0, -1).sort((a, b) => order.indexOf(a) - order.indexOf(b));
    return mods.map((m) => MAC_SYMBOLS[m] ?? m).join('') + parts.at(-1);
  }
  return parts.map((p) => (p === 'Mod' ? 'Ctrl' : p)).join('+');
}

/** Does a KeyboardEvent match a shortcut string? */
export function matchShortcut(event, shortcut) {
  const parts = shortcut.split('+');
  const key = parts.at(-1).toLowerCase();
  const want = new Set(parts.slice(0, -1));
  const mod = IS_MAC ? event.metaKey : event.ctrlKey;
  if (want.has('Mod') !== mod) return false;
  if (want.has('Shift') !== event.shiftKey) return false;
  if (want.has('Alt') !== event.altKey) return false;
  if (!IS_MAC && want.has('Ctrl') && !event.ctrlKey) return false;
  return event.key.toLowerCase() === key || event.code.toLowerCase() === key;
}
