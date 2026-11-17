// Extract pages (by range, or the current selection) into a new tab.
import { h } from '../dom.js';
import { icon } from '../icons.js';
import { t } from '../../i18n/index.js';
import { createModal } from '../dialog.js';
import { parsePageRange, formatPageRange } from '../../core/page-range.js';

export function openExtractDialog(app, tab, preselected) {
  const count = tab.pdf.numPages;
  const range = h('input.input', {
    type: 'text', id: 'extract-range', value: formatPageRange(preselected), autocomplete: 'off',
    'aria-describedby': 'extract-help',
  });
  const error = h('p.field-error', { role: 'alert', hidden: true });
  const cancelBtn = h('button.btn', { type: 'button', onclick: () => modal.close() }, t('common.cancel'));
  const runBtn = h('button.btn.primary', { type: 'button', onclick: () => run() }, icon('fileOutput'), t('extract.run'));
  const modal = createModal({
    title: t('extract.title'),
    className: 'extract-dialog',
    body: [
      h('label.field', h('span.field-label', t('extract.pages')), range,
        h('span.field-help', { id: 'extract-help' }, t('extract.help', { n: count }))),
      error,
    ],
    footer: [h('span.dialog-spacer'), cancelBtn, runBtn],
    onCancel: () => modal.close(),
  });
  range.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') run();
  });
  range.select();

  async function run() {
    const parsed = parsePageRange(range.value, count);
    if (parsed.error !== undefined || !range.value.trim()) {
      error.textContent = t('extract.bad', { part: parsed.error ?? '', n: count });
      error.hidden = false;
      range.focus();
      return;
    }
    runBtn.disabled = true;
    modal.setBusy(true);
    const ok = await app.extractPages(tab, parsed.pages);
    modal.setBusy(false);
    runBtn.disabled = false;
    if (ok) modal.close();
  }
  return modal;
}
