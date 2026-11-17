// Sanitize: remove metadata, scripts/actions, attachments, hidden layers and
// comments. The dialog first scans (a dry run of the same op) so every
// checkbox says what it would remove. One undo step.
import { h } from '../dom.js';
import { t, tn } from '../../i18n/index.js';
import { openDialog } from '../dialog.js';
import { toast } from '../toast.js';

export const SANITIZE_KEYS = ['metadata', 'javascript', 'attachments', 'hiddenLayers', 'comments'];
const DEFAULTS = { metadata: true, javascript: true, attachments: true, hiddenLayers: true, comments: false };

export async function openSanitize(app) {
  const tab = app.editableTab();
  if (!tab) return;
  const all = Object.fromEntries(SANITIZE_KEYS.map((k) => [k, true]));
  const scan = await tab.model.query('sanitize', { ...all, dryRun: true }).catch(() => null);
  const counts = scan?.counts ?? {};
  const boxes = {};
  const rows = SANITIZE_KEYS.map((key) => {
    const n = counts[key] ?? 0;
    const box = h('input', { type: 'checkbox', name: key, checked: DEFAULTS[key] && n > 0, disabled: n === 0 });
    boxes[key] = box;
    return h('label.check.sanitize-row', { dataset: { key } }, box,
      h('span.sanitize-text',
        h('span.sanitize-label', t(`sanitize.${key}`)),
        h('span.muted.sanitize-help', n ? `${t(`sanitize.${key}Help`)} · ${tn('sanitize.found', n)}` : t('sanitize.nothing'))));
  });
  const result = await openDialog({
    title: t('sanitize.title'),
    className: 'sanitize-dialog',
    body: [h('p.muted', t('sanitize.intro')), ...rows],
    actions: [
      { label: t('common.cancel'), value: null },
      { label: t('sanitize.apply'), primary: true },
    ],
    onSubmit: () => {
      const picked = Object.fromEntries(SANITIZE_KEYS.map((k) => [k, boxes[k].checked]));
      return Object.values(picked).some(Boolean) ? picked : null;
    },
  });
  if (!result) return;
  const value = await app.edit(tab, 'sanitize', result, t('step.sanitize'));
  if (value?.counts) {
    const parts = SANITIZE_KEYS.filter((k) => result[k] && value.counts[k]).map((k) => t(`sanitize.${k}`).toLowerCase());
    toast(parts.length ? t('sanitize.done', { list: parts.join(', ') }) : t('sanitize.doneNothing'));
  }
}
