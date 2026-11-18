// Application shell: top bar (brand, menus, tabs, palette, theme), the
// workspace (tools panel · viewport · side panel · rail) and the status bar.
import { h } from './dom.js';
import { icon, logo } from './icons.js';
import { t } from '../i18n/index.js';
import { formatShortcut } from './keys.js';
import { currentTheme, toggleTheme, onThemeChange } from './theme.js';

export function createShell(root, { onPalette }) {
  const themeBtn = h('button.btn.icon-btn', { type: 'button', id: 'theme-toggle', onclick: () => toggleTheme() });
  const syncThemeButton = () => {
    const dark = currentTheme() === 'dark';
    const label = t(dark ? 'topbar.theme.toLight' : 'topbar.theme.toDark');
    themeBtn.replaceChildren(icon(dark ? 'sun' : 'moon'));
    themeBtn.title = label;
    themeBtn.setAttribute('aria-label', label);
  };
  syncThemeButton();
  onThemeChange(syncThemeButton);

  const paletteBtn = h('button.btn.palette-btn', {
    type: 'button',
    id: 'palette-button',
    'aria-label': t('command.app.palette'),
    title: `${t('command.app.palette')} (${formatShortcut('Mod+K')})`,
    onclick: onPalette,
  }, icon('search', { size: 14 }), h('span.palette-btn-text', t('palette.button')), h('kbd', formatShortcut('Mod+K')));

  const menubarSlot = h('div.menubar-slot');
  const tabsSlot = h('div.tabs-slot');
  const topbar = h('header.topbar', { role: 'banner' },
    h('div.brand', logo(20), h('span.brand-name', t('app.name'))),
    menubarSlot,
    tabsSlot,
    h('div.topbar-actions', paletteBtn, themeBtn),
  );
  const main = h('main.main', { id: 'main' });
  const workspace = h('div.workspace', main);
  const statusSlot = h('div.status-slot');
  root.replaceChildren(topbar, workspace, statusSlot);

  return {
    topbar,
    menubarSlot,
    tabsSlot,
    workspace,
    main,
    setToolsSide(side) {
      workspace.dataset.toolsSide = side;
    },
    setStatusBar(el) {
      statusSlot.replaceChildren(...(el ? [el] : []));
    },
  };
}
