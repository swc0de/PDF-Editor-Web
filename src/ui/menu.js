// Popup menus (role="menu") with full keyboard support.
import { h } from './dom.js';
import { icon } from './icons.js';
import { formatShortcut } from './keys.js';

let openMenuState = null;

/**
 * @typedef {Object} MenuItem
 * @property {string} label
 * @property {string} [icon]
 * @property {string} [shortcut]
 * @property {'menuitem'|'menuitemradio'|'menuitemcheckbox'} [role]
 * @property {boolean} [checked]
 * @property {boolean} [disabled]
 * @property {string} [id]
 * @property {() => void} run
 */

/**
 * Open a menu attached to an anchor button.
 * @param {HTMLElement} anchor
 * @param {(MenuItem|'separator')[]} items
 * @param {{ placement?: 'below'|'above', label?: string }} [o]
 */
export function openMenu(anchor, items, { placement = 'below', label } = {}) {
  closeMenu();
  const menu = h('div.menu', { role: 'menu', 'aria-label': label ?? anchor.getAttribute('aria-label') ?? null, tabindex: '-1' });
  const entries = [];
  for (const item of items) {
    if (item === 'separator') {
      menu.append(h('div.menu-separator', { role: 'separator' }));
      continue;
    }
    const role = item.role ?? 'menuitem';
    const el = h('button.menu-item', {
      type: 'button',
      role,
      tabindex: '-1',
      'aria-checked': role === 'menuitem' ? null : String(!!item.checked),
      'aria-disabled': item.disabled ? 'true' : null,
      dataset: item.id ? { id: item.id } : {},
    },
      h('span.menu-check', role !== 'menuitem' && item.checked ? icon('check', { size: 14 }) : null),
      item.icon ? icon(item.icon) : h('span.menu-icon-space'),
      h('span.menu-label', item.label),
      item.shortcut ? h('span.menu-shortcut', formatShortcut(item.shortcut)) : null,
    );
    el.addEventListener('click', () => {
      if (item.disabled) return;
      closeMenu({ restoreFocus: true });
      item.run();
    });
    entries.push({ el, item });
    menu.append(el);
  }

  document.body.append(menu);
  position(menu, anchor, placement);
  anchor.setAttribute('aria-expanded', 'true');

  const focusAt = (i) => {
    const enabled = entries.filter((e) => !e.item.disabled);
    if (!enabled.length) return;
    const n = (i + enabled.length) % enabled.length;
    enabled[n].el.focus();
  };
  const indexOfFocused = () => entries.filter((e) => !e.item.disabled).findIndex((e) => e.el === document.activeElement);

  const onKey = (e) => {
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); focusAt(indexOfFocused() + 1); break;
      case 'ArrowUp': e.preventDefault(); focusAt(indexOfFocused() - 1); break;
      case 'Home': e.preventDefault(); focusAt(0); break;
      case 'End': e.preventDefault(); focusAt(-1); break;
      case 'Escape': e.preventDefault(); e.stopPropagation(); closeMenu({ restoreFocus: true }); break;
      case 'Tab': closeMenu({ restoreFocus: true }); break;
      default: break;
    }
  };
  const onPointer = (e) => {
    if (!menu.contains(e.target) && !anchor.contains(e.target)) closeMenu();
  };
  menu.addEventListener('keydown', onKey);
  document.addEventListener('pointerdown', onPointer, true);
  window.addEventListener('blur', closeMenu);
  window.addEventListener('resize', closeMenu);

  openMenuState = { menu, anchor, cleanup: () => {
    document.removeEventListener('pointerdown', onPointer, true);
    window.removeEventListener('blur', closeMenu);
    window.removeEventListener('resize', closeMenu);
  } };
  const checked = entries.findIndex((e) => e.item.checked && !e.item.disabled);
  focusAt(Math.max(0, checked));
  return menu;
}

export function closeMenu({ restoreFocus = false } = {}) {
  if (!openMenuState) return;
  const { menu, anchor, cleanup } = openMenuState;
  openMenuState = null;
  cleanup();
  menu.remove();
  anchor.setAttribute('aria-expanded', 'false');
  if (restoreFocus) anchor.focus();
}

export function isMenuOpen() {
  return !!openMenuState;
}

function position(menu, anchor, placement) {
  const r = anchor.getBoundingClientRect();
  const m = menu.getBoundingClientRect();
  const margin = 4;
  let top = placement === 'above' ? r.top - m.height - margin : r.bottom + margin;
  if (top < margin) top = r.bottom + margin;
  if (top + m.height > innerHeight - margin) top = Math.max(margin, r.top - m.height - margin);
  let left = Math.min(r.left, innerWidth - m.width - margin);
  menu.style.top = `${Math.max(margin, top)}px`;
  menu.style.left = `${Math.max(margin, left)}px`;
}
