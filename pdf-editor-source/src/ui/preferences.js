// Preferences dialog. Everything is saved in localStorage.
import { h } from './dom.js';
import { t } from '../i18n/index.js';
import { openDialog } from './dialog.js';
import { getSetting, setSetting } from '../core/settings.js';
import { themePreference, setThemePreference } from './theme.js';

const ZOOM_CHOICES = ['auto', 'fit-width', 'fit-page', 0.5, 0.75, 1, 1.25, 1.5, 2];
const LAYOUT_CHOICES = ['continuous', 'single', 'two-up', 'two-up-cover'];

function select(name, label, options, value) {
  return h('label.field', h('span.field-label', label),
    h('select.input', { name },
      options.map(([v, text]) => h('option', { value: String(v), selected: String(v) === String(value) }, text))));
}

function zoomText(z) {
  if (z === 'auto') return t('zoom.auto');
  if (z === 'fit-width') return t('zoom.fitWidth');
  if (z === 'fit-page') return t('zoom.fitPage');
  return `${Math.round(z * 100)}%`;
}

export async function openPreferences() {
  const side = getSetting('toolsSide');
  const radios = ['left', 'right'].map((v) =>
    h('label.radio', h('input', { type: 'radio', name: 'toolsSide', value: v, checked: side === v }), t(`prefs.side.${v}`)));
  const result = await openDialog({
    title: t('prefs.title'),
    className: 'prefs-dialog',
    body: [
      select('theme', t('prefs.theme'), [
        ['system', t('prefs.theme.system')],
        ['light', t('prefs.theme.light')],
        ['dark', t('prefs.theme.dark')],
      ], themePreference()),
      h('fieldset.field.radio-group', h('legend.field-label', t('prefs.toolsSide')), radios),
      h('label.field', h('span.field-label', t('prefs.author')),
        h('input.input', { type: 'text', name: 'author', value: getSetting('author'), maxlength: 80, autocomplete: 'name', placeholder: t('prefs.author.placeholder') }),
        h('span.field-help', t('prefs.author.help'))),
      select('defaultZoom', t('prefs.defaultZoom'), ZOOM_CHOICES.map((z) => [z, zoomText(z)]), getSetting('defaultZoom')),
      select('defaultLayout', t('prefs.defaultLayout'), LAYOUT_CHOICES.map((l) => [l, t(`layout.${l === 'two-up' ? 'twoUp' : l === 'two-up-cover' ? 'twoUpCover' : l}`)]), getSetting('defaultLayout')),
    ],
    actions: [
      { label: t('common.cancel'), value: null },
      { label: t('common.save'), primary: true },
    ],
    onSubmit: (form) => Object.fromEntries(new FormData(form)),
  });
  if (!result) return false;
  setThemePreference(result.theme);
  setSetting('toolsSide', result.toolsSide);
  setSetting('author', result.author.trim());
  const z = result.defaultZoom;
  setSetting('defaultZoom', ['auto', 'fit-width', 'fit-page'].includes(z) ? z : Number(z));
  setSetting('defaultLayout', result.defaultLayout);
  return true;
}
