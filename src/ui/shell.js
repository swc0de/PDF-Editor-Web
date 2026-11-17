// Application shell: top bar, main area and a status-bar slot. M2 adds the
// tab strip, menus, tools panel and side panels.
import { h } from './dom.js';
import { icon, logo } from './icons.js';
import { t } from '../i18n/index.js';
import { formatShortcut } from './keys.js';
import { currentTheme, toggleTheme, onThemeChange } from './theme.js';

export function createShell(root, { onOpen, onClose }) {
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

  const openLabel = t('command.file.open');
  const openBtn = h('button.btn.icon-btn', {
    type: 'button',
    id: 'topbar-open',
    'aria-label': openLabel,
    title: `${openLabel} (${formatShortcut('Mod+O')})`,
    onclick: onOpen,
  }, icon('folderOpen'));

  const docName = h('span.doc-name');
  const closeBtn = h('button.btn.icon-btn.doc-close', {
    type: 'button',
    'aria-label': t('command.file.close'),
    title: t('command.file.close'),
    onclick: onClose,
  }, icon('x', { size: 14 }));
  const docSlot = h('div.doc-title', { hidden: true }, icon('file', { size: 14 }), docName, closeBtn);

  const topbar = h('header.topbar', { role: 'banner' },
    h('div.brand', logo(20), h('span.brand-name', t('app.name'))),
    docSlot,
    h('div.topbar-spacer'),
    h('div.topbar-actions', openBtn, themeBtn),
  );
  const main = h('main.main', { id: 'main' });
  const statusSlot = h('div.status-slot');
  root.replaceChildren(topbar, main, statusSlot);

  return {
    topbar,
    main,
    setDocument(name) {
      docSlot.hidden = !name;
      docName.textContent = name ?? '';
      docName.title = name ?? '';
    },
    setStatusBar(el) {
      statusSlot.replaceChildren(...(el ? [el] : []));
    },
  };
}
