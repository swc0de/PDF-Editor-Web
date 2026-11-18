// Help → About and Help → Keyboard shortcuts.
import { h } from './dom.js';
import { logo } from './icons.js';
import { t } from '../i18n/index.js';
import { openDialog } from './dialog.js';
import { formatShortcut } from './keys.js';
import { listCommands } from './commands.js';
import { LIBS } from '../core/libs.config.js';
import { VERSION } from '../core/version.js';

export function openAbout() {
  return openDialog({
    title: t('app.name'),
    className: 'about-dialog',
    body: [
      h('div.about-head', logo(40), h('div',
        h('p.about-version', t('about.version', { version: VERSION })),
        h('p.muted', t('about.tagline')))),
      h('p', t('app.privacyDetail')),
      h('table.about-libs',
        h('caption', t('about.libraries')),
        h('thead', h('tr', h('th', { scope: 'col' }, t('about.library')), h('th', { scope: 'col' }, t('about.libVersion')), h('th', { scope: 'col' }, t('about.license')))),
        h('tbody', aboutRows().map((lib) => h('tr',
          h('td', h('a', { href: lib.homepage, target: '_blank', rel: 'noopener noreferrer' }, lib.pkg)),
          h('td', lib.version),
          h('td', lib.license))))),
      h('p.about-credit', t('about.inspired')),
    ],
    actions: [{ label: t('common.close'), value: true, primary: true }],
    cancelValue: true,
  });
}

export function openShortcuts() {
  const rows = listCommands()
    .filter((c) => c.shortcut)
    .map((c) => {
      const list = Array.isArray(c.shortcut) ? c.shortcut : [c.shortcut];
      return h('tr', h('td', t(c.label)), h('td', list.map((s) => h('kbd', formatShortcut(s)))));
    });
  return openDialog({
    title: t('shortcuts.title'),
    className: 'shortcuts-dialog',
    // Focusable so keyboard users can scroll it.
    body: h('div.shortcuts-scroll', { tabIndex: 0, role: 'region', 'aria-label': t('shortcuts.title') }, h('table.shortcuts-table', h('tbody', rows))),
    actions: [{ label: t('common.close'), value: true, primary: true }],
    cancelValue: true,
  });
}

/** Libraries for the About table; OCR language packages are one row. */
function aboutRows() {
  const libs = Object.values(LIBS);
  const data = libs.filter((l) => l.group === 'tessdata');
  const rows = libs.filter((l) => !l.group);
  if (data.length) {
    rows.push({ ...data[0], pkg: `@tesseract.js-data/* (${data.map((l) => l.pkg.split('/')[1]).join(', ')})` });
  }
  return rows;
}
