// Command palette (⌘K): fuzzy search over every command and tool.
import { h } from './dom.js';
import { icon } from './icons.js';
import { t } from '../i18n/index.js';
import { formatShortcut } from './keys.js';
import { fuzzyScore } from './fuzzy.js';
import { getPref, setPref } from '../core/prefs.js';

const RECENT_KEY = 'palette.recent';
const MAX_RECENT = 8;
const MAX_RESULTS = 60;

export function recentPaletteIds() {
  return getPref(RECENT_KEY, []);
}

function remember(id) {
  setPref(RECENT_KEY, [id, ...recentPaletteIds().filter((x) => x !== id)].slice(0, MAX_RECENT));
}

/**
 * @typedef {Object} PaletteItem
 * @property {string} id         unique (commands: "view.zoomIn", tools: "tool:find")
 * @property {string} label
 * @property {string} [group]    shown on the right (e.g. "View", "Tool")
 * @property {string} [icon]
 * @property {string} [shortcut]
 * @property {boolean} [disabled]
 * @property {string} [hint]     e.g. "Coming soon"
 * @property {() => void} run
 */

let openDialog = null;

/** @param {() => PaletteItem[]} getItems */
export function openPalette(getItems) {
  if (openDialog?.open) {
    openDialog.querySelector('input').focus();
    return;
  }
  // A palette that was just closed may not have fired 'close' yet.
  openDialog?.remove();
  openDialog = null;
  const items = getItems();
  const input = h('input.palette-input', {
    type: 'text',
    role: 'combobox',
    'aria-expanded': 'true',
    'aria-controls': 'palette-list',
    'aria-autocomplete': 'list',
    'aria-label': t('palette.label'),
    placeholder: t('palette.placeholder'),
    autocomplete: 'off',
    spellcheck: false,
  });
  const list = h('ul.palette-list', { id: 'palette-list', role: 'listbox', 'aria-label': t('palette.results') });
  const empty = h('p.palette-empty', { hidden: true }, t('palette.noResults'));
  const dialog = h('dialog.dialog.palette', { 'aria-label': t('palette.label') },
    h('div.palette-search', icon('search'), input),
    list,
    empty,
  );
  openDialog = dialog;

  let results = [];
  let active = 0;

  function search() {
    const q = input.value.trim();
    const recent = recentPaletteIds();
    const rank = (item) => {
      const r = recent.indexOf(item.id);
      return r < 0 ? 0 : (MAX_RECENT - r) * 25;
    };
    if (!q) {
      const recents = recent.map((id) => items.find((i) => i.id === id)).filter(Boolean);
      const rest = items.filter((i) => !recent.includes(i.id)).sort((a, b) => a.label.localeCompare(b.label));
      results = [...recents.map((i) => ({ ...i, recent: true })), ...rest];
    } else {
      results = items
        .map((item) => {
          const s = Math.max(fuzzyScore(q, item.label), fuzzyScore(q, item.id) - 50);
          return { item, s: s === -Infinity ? s : s + rank(item) - (item.disabled ? 40 : 0) };
        })
        .filter((r) => r.s > -Infinity)
        .sort((a, b) => b.s - a.s)
        .map((r) => ({ ...r.item, recent: recent.includes(r.item.id) }));
    }
    results = results.slice(0, MAX_RESULTS);
    active = 0;
    renderList();
  }

  function renderList() {
    list.replaceChildren(...results.map((item, i) =>
      h('li.palette-item', {
        id: `palette-opt-${i}`,
        role: 'option',
        'aria-selected': String(i === active),
        'aria-disabled': item.disabled ? 'true' : null,
        dataset: { id: item.id },
        onpointermove: () => { if (active !== i) { active = i; updateActive(); } },
        onclick: () => choose(i),
      },
        item.icon ? icon(item.icon) : h('span.menu-icon-space'),
        h('span.palette-label', item.label),
        item.recent && !input.value.trim() ? h('span.palette-tag', t('palette.recent')) : null,
        item.hint ? h('span.badge', item.hint) : null,
        h('span.palette-group', item.group ?? ''),
        item.shortcut ? h('kbd.palette-shortcut', formatShortcut(item.shortcut)) : null,
      ),
    ));
    empty.hidden = results.length > 0;
    updateActive();
  }

  function updateActive() {
    [...list.children].forEach((li, i) => li.setAttribute('aria-selected', String(i === active)));
    const el = list.children[active];
    if (el) {
      input.setAttribute('aria-activedescendant', el.id);
      el.scrollIntoView({ block: 'nearest' });
    } else {
      input.removeAttribute('aria-activedescendant');
    }
  }

  function choose(i) {
    const item = results[i];
    if (!item || item.disabled) return;
    remember(item.id);
    dialog.close();
    item.run();
  }

  input.addEventListener('input', search);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      active = Math.min(results.length - 1, active + 1);
      updateActive();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      active = Math.max(0, active - 1);
      updateActive();
    } else if (e.key === 'PageDown' || e.key === 'PageUp') {
      e.preventDefault();
      active = Math.max(0, Math.min(results.length - 1, active + (e.key === 'PageDown' ? 8 : -8)));
      updateActive();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      choose(active);
    }
  });
  dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.close(); });
  dialog.addEventListener('close', () => {
    dialog.remove();
    if (openDialog === dialog) openDialog = null;
  });
  document.body.append(dialog);
  dialog.showModal();
  input.focus();
  search();
}
