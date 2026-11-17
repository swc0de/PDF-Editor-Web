// Application shell: top bar + main area. Later milestones add the tab strip,
// menus, tools panel, side panels, find bar and status bar here.
import { h } from './dom.js';
import { icon, logo } from './icons.js';
import { t } from '../i18n/index.js';
import { currentTheme, toggleTheme, onThemeChange } from './theme.js';

export function createShell(root) {
  const themeBtn = h('button.btn.icon-btn', {
    type: 'button',
    id: 'theme-toggle',
    onclick: () => toggleTheme(),
  });
  const syncThemeButton = () => {
    const dark = currentTheme() === 'dark';
    const label = t(dark ? 'topbar.theme.toLight' : 'topbar.theme.toDark');
    themeBtn.replaceChildren(icon(dark ? 'sun' : 'moon'));
    themeBtn.title = label;
    themeBtn.setAttribute('aria-label', label);
  };
  syncThemeButton();
  onThemeChange(syncThemeButton);

  const topbar = h(
    'header.topbar',
    { role: 'banner' },
    h('div.brand', logo(20), h('span.brand-name', t('app.name'))),
    h('div.topbar-spacer'),
    h('div.topbar-actions', themeBtn),
  );

  const main = h('main.main', { id: 'main' });
  root.replaceChildren(topbar, main);
  return { topbar, main };
}
