// Popup menus (role="menu") with full keyboard support. Used by the menu bar,
// the status bar pickers and context menus.
import { h } from './dom.js';
import { icon } from './icons.js';
import { formatShortcut } from './keys.js';

let openMenuState = null;

/**
 * @typedef {Object} MenuItem
 * @property {string} label
 * @property {string} [icon]
 * @property {string} [shortcut]
 * @property {string} [hint]       right-aligned note, e.g. "Coming soon"
 * @property {'menuitem'|'menuitemradio'|'menuitemcheckbox'} [role]
 * @property {boolean} [checked]
 * @property {boolean} [disabled]
 * @property {string} [id]
 * @property {() => void} run
 */

/**
 * Open a menu attached to an anchor element (or at a point, for context menus).
 * @param {HTMLElement} anchor   focus returns here; aria-expanded is managed on it
 * @param {(MenuItem|'separator')[]} items
 * @param {object} [o]
 * @param {'below'|'above'} [o.placement]
 * @param {string} [o.label]
 * @param {{x:number,y:number}} [o.at]   open at this viewport point
 * @param {(dir: -1|1) => void} [o.onNavigate]  ←/→ pressed (menu bars)
 * @param {boolean} [o.focusFirst]  focus the first item (default true)
 * @param {() => void} [o.onClose]
 */
export function openMenu(anchor, items, { placement = 'below', label, at, onNavigate, focusFirst = true, onClose } = {}) {
  closeMenu();
  const menu = h('div.menu', {
    role: 'menu',
    'aria-label': label ?? anchor?.getAttribute('aria-label') ?? anchor?.textContent ?? null,
    tabindex: '-1',
  });
  const entries = [];
  for (const item of items) {
    if (item === 'separator') {
      if (menu.lastChild && !menu.lastChild.classList.contains('menu-separator')) {
        menu.append(h('div.menu-separator', { role: 'separator' }));
      }
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
      item.hint ? h('span.menu-hint', item.hint) : null,
      item.shortcut ? h('span.menu-shortcut', formatShortcut(item.shortcut)) : null,
    );
    el.addEventListener('click', () => {
      if (item.disabled) return;
      closeMenu({ restoreFocus: true });
      item.run();
    });
    el.addEventListener('pointerenter', () => {
      if (!item.disabled) el.focus({ preventScroll: true });
    });
    entries.push({ el, item });
    menu.append(el);
  }
  if (menu.lastChild?.classList.contains('menu-separator')) menu.lastChild.remove();

  document.body.append(menu);
  if (at) positionAt(menu, at);
  else position(menu, anchor, placement);
  anchor?.setAttribute('aria-expanded', 'true');

  const enabled = () => entries.filter((e) => !e.item.disabled);
  const focusAt = (i) => {
    const list = enabled();
    if (!list.length) return menu.focus();
    list[(i + list.length) % list.length].el.focus();
  };
  const focusedIndex = () => enabled().findIndex((e) => e.el === document.activeElement);

  const onKey = (e) => {
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); focusAt(focusedIndex() + 1); break;
      case 'ArrowUp': e.preventDefault(); focusAt(focusedIndex() < 0 ? -1 : focusedIndex() - 1); break;
      case 'Home': e.preventDefault(); focusAt(0); break;
      case 'End': e.preventDefault(); focusAt(-1); break;
      case 'ArrowLeft':
      case 'ArrowRight':
        if (onNavigate) {
          e.preventDefault();
          onNavigate(e.key === 'ArrowLeft' ? -1 : 1);
        }
        break;
      case 'Escape': e.preventDefault(); e.stopPropagation(); closeMenu({ restoreFocus: true }); break;
      case 'Tab': e.preventDefault(); closeMenu({ restoreFocus: true }); break;
      default: {
        // Type-ahead: jump to the next item starting with the typed letter.
        if (e.key.length === 1 && /\S/.test(e.key) && !e.ctrlKey && !e.metaKey) {
          const list = enabled();
          const start = focusedIndex();
          for (let k = 1; k <= list.length; k++) {
            const cand = list[(start + k) % list.length];
            if (cand.item.label.toLowerCase().startsWith(e.key.toLowerCase())) {
              cand.el.focus();
              break;
            }
          }
        }
      }
    }
  };
  const onPointer = (e) => {
    if (!menu.contains(e.target) && !anchor?.contains(e.target)) closeMenu();
  };
  menu.addEventListener('keydown', onKey);
  document.addEventListener('pointerdown', onPointer, true);
  window.addEventListener('blur', closeMenu);
  window.addEventListener('resize', closeMenu);

  openMenuState = {
    menu,
    anchor,
    onClose,
    cleanup: () => {
      document.removeEventListener('pointerdown', onPointer, true);
      window.removeEventListener('blur', closeMenu);
      window.removeEventListener('resize', closeMenu);
    },
  };
  if (focusFirst) {
    const checked = enabled().findIndex((e) => e.item.checked);
    focusAt(Math.max(0, checked));
  } else {
    menu.focus();
  }
  return menu;
}

export function closeMenu({ restoreFocus = false } = {}) {
  if (!openMenuState) return;
  const { menu, anchor, cleanup, onClose } = openMenuState;
  openMenuState = null;
  cleanup();
  menu.remove();
  anchor?.setAttribute('aria-expanded', 'false');
  onClose?.();
  if (restoreFocus) anchor?.focus();
}

export function isMenuOpen() {
  return !!openMenuState;
}

export function openMenuAnchor() {
  return openMenuState?.anchor ?? null;
}

function position(menu, anchor, placement) {
  const r = anchor.getBoundingClientRect();
  const m = menu.getBoundingClientRect();
  const margin = 4;
  let top = placement === 'above' ? r.top - m.height - margin : r.bottom + margin;
  if (top < margin) top = r.bottom + margin;
  if (top + m.height > innerHeight - margin) top = Math.max(margin, r.top - m.height - margin);
  const left = Math.min(r.left, innerWidth - m.width - margin);
  menu.style.top = `${Math.max(margin, top)}px`;
  menu.style.left = `${Math.max(margin, left)}px`;
}

function positionAt(menu, { x, y }) {
  const m = menu.getBoundingClientRect();
  const margin = 4;
  menu.style.left = `${Math.max(margin, Math.min(x, innerWidth - m.width - margin))}px`;
  menu.style.top = `${Math.max(margin, Math.min(y, innerHeight - m.height - margin))}px`;
}
