// Command registry: every user action with a label, optional shortcut(s) and
// an enabled() check. Keyboard shortcuts, menus (M2) and the command palette
// (M2) all go through here.
import { matchShortcut } from './keys.js';

const commands = new Map();

/**
 * @param {object} c
 * @param {string} c.id
 * @param {string} c.label        i18n key
 * @param {string|string[]} [c.shortcut]   first one is shown in the UI
 * @param {string} [c.icon]
 * @param {() => boolean} [c.enabled]
 * @param {() => boolean} [c.checked]
 * @param {(...args) => any} c.run
 */
export function defineCommand(c) {
  if (commands.has(c.id)) throw new Error(`Command defined twice: ${c.id}`);
  commands.set(c.id, { enabled: () => true, ...c });
}

export function getCommand(id) {
  return commands.get(id) ?? null;
}

export function listCommands() {
  return [...commands.values()];
}

export function isEnabled(id) {
  const c = commands.get(id);
  return !!c && c.enabled();
}

export function runCommand(id, ...args) {
  const c = commands.get(id);
  if (!c) throw new Error(`Unknown command: ${id}`);
  if (!c.enabled()) return false;
  c.run(...args);
  return true;
}

/** The label to show: a command may compute it (e.g. "Undo Rotate page 3"). */
export function commandLabel(c, t) {
  return c.getLabel?.() ?? t(c.label);
}

export function primaryShortcut(id) {
  const s = commands.get(id)?.shortcut;
  return Array.isArray(s) ? s[0] : (s ?? null);
}

/** Global keydown handler. Returns true if a command handled the event. */
export function handleShortcut(event) {
  const editable = event.target?.closest?.('input, textarea, select, [contenteditable="true"]');
  for (const c of commands.values()) {
    if (!c.shortcut) continue;
    const list = Array.isArray(c.shortcut) ? c.shortcut : [c.shortcut];
    const hit = list.find((s) => matchShortcut(event, s));
    if (!hit) continue;
    // In text fields only modifier/function-key shortcuts apply.
    if (editable && !/Mod|Ctrl|Alt|(^|\+)F\d+$/.test(hit)) continue;
    // Arrow-key shortcuts (e.g. Alt+← for Back) would break caret movement.
    if (editable && /Arrow/.test(hit)) continue;
    // Commands like Undo leave text fields their native behaviour.
    if (editable && c.inInput === false) continue;
    if (!c.enabled()) continue;
    event.preventDefault();
    c.run();
    return true;
  }
  return false;
}
