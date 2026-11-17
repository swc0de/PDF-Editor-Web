// Combine files: a reorderable list of PDFs (from disk or open tabs), an
// optional page range per file and "Add a bookmark for each file". The work
// runs in a job worker with progress and Cancel; the result opens in a tab.
import { h } from '../dom.js';
import { icon } from '../icons.js';
import { t, tn } from '../../i18n/index.js';
import { createModal } from '../dialog.js';
import { openMenu } from '../menu.js';
import { toast } from '../toast.js';
import { formatBytes } from '../format.js';
import { parsePageRange } from '../../core/page-range.js';
import { inspectPdf } from '../../view/pdfjs.js';
import { runJob } from '../../core/jobs.js';
import { createJobProgress } from './job-progress.js';

let nextItem = 1;

export function openCombineDialog(app) {
  const items = []; // { id, name, bytes, pageCount, range, source }
  let job = null;

  const list = h('ol.combine-list', { 'aria-label': t('combine.files') });
  const empty = h('p.combine-empty.muted', t('combine.empty'));
  const fileInput = h('input', { type: 'file', id: 'combine-file-input', accept: 'application/pdf,.pdf', multiple: true, hidden: true });
  const addFiles = h('button.btn', { type: 'button', onclick: () => fileInput.click() }, icon('folderOpen'), t('combine.addFiles'));
  const addTab = h('button.btn', { type: 'button', 'aria-haspopup': 'menu', 'aria-expanded': 'false' }, icon('files'), t('combine.addOpen'), icon('chevronDown', { size: 14 }));
  const bookmarks = h('input', { type: 'checkbox', checked: true, id: 'combine-bookmarks' });
  const outName = h('input.input', { type: 'text', value: 'Combined.pdf', id: 'combine-name', autocomplete: 'off' });
  const error = h('p.field-error', { role: 'alert', hidden: true });
  const progress = createJobProgress({ onCancel: () => job?.cancel() });
  const cancelBtn = h('button.btn', { type: 'button', onclick: () => modal.close() }, t('common.cancel'));
  const runBtn = h('button.btn.primary', { type: 'button', onclick: () => run() }, icon('files'), t('combine.run'));

  const modal = createModal({
    title: t('combine.title'),
    className: 'combine-dialog',
    body: [
      h('div.combine-add', addFiles, addTab, fileInput),
      h('div.combine-list-wrap', list, empty),
      h('label.check', bookmarks, h('span', t('combine.bookmarks'))),
      h('label.field', h('span.field-label', t('combine.name')), outName),
      error,
    ],
    footer: [progress.el, h('span.dialog-spacer'), cancelBtn, runBtn],
    onCancel: () => modal.close(),
  });

  const showError = (msg) => {
    error.textContent = msg ?? '';
    error.hidden = !msg;
  };

  function render() {
    empty.hidden = items.length > 0;
    runBtn.disabled = items.length === 0 || !!job;
    list.replaceChildren(...items.map((item, i) => {
      const range = h('input.input.combine-range', {
        type: 'text',
        value: item.range,
        placeholder: t('combine.allPages'),
        'aria-label': t('combine.rangeFor', { name: item.name }),
        autocomplete: 'off',
        oninput: (e) => { item.range = e.target.value; row.classList.remove('invalid'); },
      });
      const move = (dir, name, label) => h('button.btn.icon-btn', {
        type: 'button',
        'aria-label': t(label, { name: item.name }),
        title: t(label, { name: item.name }),
        disabled: (dir < 0 && i === 0) || (dir > 0 && i === items.length - 1),
        onclick: () => {
          items.splice(i + dir, 0, ...items.splice(i, 1));
          render();
          list.children[i + dir]?.querySelector(dir < 0 ? '[data-move="up"]' : '[data-move="down"]')?.focus();
        },
        dataset: { move: dir < 0 ? 'up' : 'down' },
      }, icon(name, { size: 14 }));
      const row = h('li.combine-row', { draggable: 'true', dataset: { id: String(item.id) } },
        h('span.combine-grip', { 'aria-hidden': 'true' }, icon('grip', { size: 14 })),
        icon(item.source === 'tab' ? 'files' : 'file'),
        h('div.combine-info',
          h('span.combine-name', item.name),
          h('span.muted.combine-meta', `${tn('combine.pages', item.pageCount)} · ${formatBytes(item.bytes.length)}${item.source === 'tab' ? ` · ${t('combine.fromTab')}` : ''}`)),
        range,
        move(-1, 'chevronUp', 'combine.moveUp'),
        move(1, 'chevronDown', 'combine.moveDown'),
        h('button.btn.icon-btn', {
          type: 'button',
          'aria-label': t('combine.remove', { name: item.name }),
          title: t('combine.remove', { name: item.name }),
          onclick: () => {
            items.splice(i, 1);
            render();
          },
        }, icon('x', { size: 14 })),
      );
      return row;
    }));
  }

  // Drag rows to reorder (keyboard users have the ↑/↓ buttons).
  let dragId = null;
  list.addEventListener('dragstart', (e) => {
    const row = e.target.closest('.combine-row');
    if (!row) return;
    dragId = Number(row.dataset.id);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', row.dataset.id);
    row.classList.add('dragging');
  });
  list.addEventListener('dragover', (e) => {
    if (dragId === null) return;
    e.preventDefault();
    const row = e.target.closest('.combine-row');
    list.querySelectorAll('.drop-before, .drop-after').forEach((r) => r.classList.remove('drop-before', 'drop-after'));
    if (!row) return;
    const r = row.getBoundingClientRect();
    row.classList.add(e.clientY < r.top + r.height / 2 ? 'drop-before' : 'drop-after');
  });
  list.addEventListener('drop', (e) => {
    if (dragId === null) return;
    e.preventDefault();
    const row = e.target.closest('.combine-row');
    const from = items.findIndex((it) => it.id === dragId);
    if (row && from >= 0) {
      let to = items.findIndex((it) => it.id === Number(row.dataset.id));
      if (row.classList.contains('drop-after')) to += 1;
      const [moved] = items.splice(from, 1);
      items.splice(to > from ? to - 1 : to, 0, moved);
    }
    dragId = null;
    render();
  });
  list.addEventListener('dragend', () => {
    dragId = null;
    list.querySelectorAll('.dragging, .drop-before, .drop-after').forEach((r) => r.classList.remove('dragging', 'drop-before', 'drop-after'));
  });

  async function addBytes(bytes, name, source) {
    try {
      const { pageCount } = await inspectPdf(bytes);
      items.push({ id: nextItem++, name, bytes, pageCount, range: '', source });
      showError(null);
      render();
    } catch (err) {
      showError(err.name === 'PasswordProtected' ? t('combine.protected', { name }) : t('combine.invalid', { name }));
    }
  }

  fileInput.addEventListener('change', async () => {
    const files = [...(fileInput.files ?? [])];
    fileInput.value = '';
    for (const file of files) await addBytes(new Uint8Array(await file.arrayBuffer()), file.name, 'disk');
  });

  addTab.addEventListener('click', () => {
    openMenu(addTab, app.tabs.length
      ? app.tabs.map((tab) => ({
        label: tab.name,
        icon: 'file',
        disabled: !!tab.model.readOnly,
        hint: tab.model.readOnly ? t('combine.protectedShort') : tab.dirty ? t('combine.unsavedIncluded') : null,
        run: () => addBytes(tab.bytes, tab.name, 'tab'),
      }))
      : [{ label: t('combine.noOpen'), disabled: true, run: () => {} }],
    { label: t('combine.addOpen') });
  });

  async function run() {
    const files = [];
    for (const item of items) {
      const parsed = parsePageRange(item.range, item.pageCount);
      if (parsed.error !== undefined) {
        showError(t('combine.badRange', { name: item.name, part: parsed.error, n: item.pageCount }));
        list.querySelector(`[data-id="${item.id}"]`)?.classList.add('invalid');
        list.querySelector(`[data-id="${item.id}"] .combine-range`)?.focus();
        return;
      }
      files.push({ name: item.name, bytes: item.bytes.slice(), pages: item.range.trim() ? parsed.pages : null });
    }
    let name = outName.value.trim() || 'Combined.pdf';
    if (!/\.pdf$/i.test(name)) name += '.pdf';
    showError(null);
    modal.setBusy(true);
    runBtn.disabled = true;
    cancelBtn.hidden = true;
    progress.start(t('job.starting'));
    job = runJob('combine', { files, bookmarks: bookmarks.checked }, {
      transfer: files.map((f) => f.bytes.buffer),
      onProgress: ({ done, total, label }) => progress.set(done, total,
        label === 'save' ? t('job.saving') : label === 'done' ? t('job.done') : t('combine.progress', { n: done + 1, total: total - 1, name: label })),
    });
    try {
      const result = await job.promise;
      modal.close();
      await app.openBytes(result.bytes, name, { clean: false, openLabel: tn('history.combined', items.length) });
      toast(tn('combine.done', items.length, { pages: result.pageCount }));
    } catch (err) {
      if (err.name === 'JobCancelled') toast(t('job.cancelled'));
      else showError(t('combine.failed', { message: err.message }));
    } finally {
      job = null;
      modal.setBusy(false);
      progress.stop();
      cancelBtn.hidden = false;
      render();
    }
  }

  // Start with the active document, if any.
  if (app.activeTab && !app.activeTab.model.readOnly) addBytes(app.activeTab.bytes, app.activeTab.name, 'tab');
  render();
  return modal;
}
