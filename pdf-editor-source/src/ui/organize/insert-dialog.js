// "Insert pages from a PDF" dialog: choose a file, a page range and where.
import { h } from '../dom.js';
import { t, tn } from '../../i18n/index.js';
import { openDialog } from '../dialog.js';
import { parsePageRange } from '../../core/page-range.js';
import { getPdfjs, destroyPdf, pdfjsIdle } from '../../view/pdfjs.js';

/**
 * @param {{ count: number, defaultAfter: number }} o  defaultAfter: 1-based page to insert after (0 = start)
 * @returns {Promise<{ bytes: Uint8Array, name: string, pages: number[], at: number } | null>}
 */
export async function openInsertDialog({ count, defaultAfter }) {
  let source = null; // { bytes, name, pageCount }
  const fileInput = h('input', { type: 'file', accept: 'application/pdf,.pdf', hidden: true, id: 'insert-file-input' });
  const fileName = h('span.insert-file-name.muted', t('insert.noFile'));
  const chooseBtn = h('button.btn', { type: 'button', onclick: () => fileInput.click() }, t('insert.choose'));
  const range = h('input.input', {
    type: 'text', name: 'range', placeholder: t('insert.rangePlaceholder'),
    'aria-describedby': 'insert-range-help', autocomplete: 'off',
  });
  const where = h('select.input', { name: 'where', 'aria-label': t('insert.position') },
    h('option', { value: 'after', selected: true }, t('insert.after')),
    h('option', { value: 'before' }, t('insert.before')),
    h('option', { value: 'start' }, t('insert.start')),
    h('option', { value: 'end' }, t('insert.end')));
  const pageNo = h('input.input.insert-page-no', {
    type: 'number', name: 'page', min: '1', max: String(count), value: String(Math.max(1, defaultAfter)),
    'aria-label': t('insert.pageNumber'),
  });
  const error = h('p.field-error', { role: 'alert', hidden: true });
  const syncWhere = () => { pageNo.disabled = where.value === 'start' || where.value === 'end'; };
  where.addEventListener('change', syncWhere);
  if (defaultAfter === 0) where.value = 'start';
  syncWhere();

  const showError = (msg) => {
    error.textContent = msg;
    error.hidden = !msg;
  };

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    showError('');
    const bytes = new Uint8Array(await file.arrayBuffer());
    try {
      const pdfjs = await getPdfjs();
      await pdfjsIdle();
      const task = pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false, verbosity: 0 });
      task.onPassword = () => destroyPdf(task);
      const doc = await task.promise;
      source = { bytes, name: file.name, pageCount: doc.numPages };
      await destroyPdf(task);
      fileName.textContent = `${file.name} — ${tn('insert.pages', source.pageCount)}`;
      fileName.classList.remove('muted');
    } catch {
      source = null;
      fileName.textContent = t('insert.noFile');
      showError(t('insert.badFile', { name: file.name }));
    }
  });

  return openDialog({
    title: t('insert.title'),
    className: 'insert-dialog',
    body: [
      h('div.field', h('span.field-label', t('insert.file')), h('div.insert-file', chooseBtn, fileName, fileInput)),
      h('label.field', h('span.field-label', t('insert.range')), range,
        h('span.field-help', { id: 'insert-range-help' }, t('insert.rangeHelp'))),
      h('div.field', h('span.field-label', t('insert.position')), h('div.insert-where', where, pageNo)),
      error,
    ],
    actions: [
      { label: t('common.cancel'), value: null },
      { label: t('insert.insert'), primary: true },
    ],
    cancelValue: null,
    onSubmit: () => {
      if (!source) {
        showError(t('insert.needFile'));
        return undefined;
      }
      const parsed = parsePageRange(range.value, source.pageCount);
      if (parsed.error !== undefined) {
        showError(t('insert.badRange', { part: parsed.error, n: source.pageCount }));
        return undefined;
      }
      const n = Number(pageNo.value);
      if (!pageNo.disabled && !(n >= 1 && n <= count)) {
        showError(t('insert.badPage', { n: count }));
        return undefined;
      }
      const at = { start: 0, end: count, before: n - 1, after: n }[where.value];
      return { bytes: source.bytes, name: source.name, pages: parsed.pages, at };
    },
  });
}
