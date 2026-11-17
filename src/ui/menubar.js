// Application menu bar (role="menubar") with roving focus. Each top-level
// item opens a menu whose items are built fresh (so enabled/checked states
// are always current).
import { h } from './dom.js';
import { openMenu, closeMenu, isMenuOpen, openMenuAnchor } from './menu.js';

/** @param {{ id:string, label:string, items: () => any[] }[]} menus */
export function createMenubar(menus, { label }) {
  const bar = h('div.menubar', { role: 'menubar', 'aria-label': label });
  const buttons = menus.map((m, i) =>
    h('button.menubar-item', {
      type: 'button',
      role: 'menuitem',
      'aria-haspopup': 'menu',
      'aria-expanded': 'false',
      tabindex: i === 0 ? '0' : '-1',
      dataset: { menu: m.id },
    }, m.label),
  );
  bar.append(...buttons);

  const open = (i, { focusFirst = true } = {}) => {
    const n = (i + menus.length) % menus.length;
    const btn = buttons[n];
    buttons.forEach((b) => b.setAttribute('tabindex', b === btn ? '0' : '-1'));
    openMenu(btn, menus[n].items(), {
      label: menus[n].label,
      focusFirst,
      onNavigate: (dir) => open(n + dir),
    });
  };

  buttons.forEach((btn, i) => {
    btn.addEventListener('click', () => {
      if (isMenuOpen() && openMenuAnchor() === btn) closeMenu();
      else open(i);
    });
    // Once a menu is open, hovering another top-level item switches to it.
    btn.addEventListener('pointerenter', () => {
      if (isMenuOpen() && buttons.includes(openMenuAnchor()) && openMenuAnchor() !== btn) open(i);
    });
    btn.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        e.preventDefault();
        const j = (i + (e.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
        buttons.forEach((b) => b.setAttribute('tabindex', b === buttons[j] ? '0' : '-1'));
        buttons[j].focus();
      } else if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        open(i);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        open(i);
      }
    });
  });

  return { el: bar, open: (id) => open(menus.findIndex((m) => m.id === id)) };
}
