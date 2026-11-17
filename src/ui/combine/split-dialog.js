// Split the active document every N pages, before chosen pages, or at its
// top-level bookmarks. Parts are zipped in a job worker and downloaded.
import { h } from '../dom.js';
import { icon } from '../icons.js';
import { t, tn } from '../../i18n/index.js';
import { createModal } from '../dialog.js';
import { toast } from '../toast.js';
import { runJob } from '../../core/jobs.js';
import { planSplit } from '../../core/split-plan.js';
import { downloadBytes } from '../save.js';
import { createJobProgress } from './job-progress.js';

async function topLevelStarts(tab) {
  const outline = await tab.pdf.getOutline().catch(() => null);
  if (!outline?.length) return [];
  const out = [];
  for (const item of outline) {
    let dest = item.dest;
    if (typeof dest === 'string') dest = await tab.pdf.getDestination(dest).catch(() => null);
    if (!Array.isArray(dest)) continue;
    const ref = dest[0];
    const page = Number.isInteger(ref) ? ref : await tab.pdf.getPageIndex(ref).catch(() => null);
    if (page !== null) out.push({ page, title: item.title });
  }
  return out;
}

export async function openSplitDialog(app, tab) {
  const count = tab.pdf.numPages;
  const base = tab.name.replace(/\.pdf$/i, '');
  const starts = await topLevelStarts(tab);
  let job = null;

  const radio = (value, labelKey, extra, disabled = false) => h('label.split-option',
    h('input', { type: 'radio', name: 'split-mode', value, checked: value === 'every', disabled }),
    h('span', t(labelKey)), extra);
  const every = h('input.input.split-every', { type: 'number', min: '1', max: String(count), value: String(Math.min(count, Math.max(1, Math.ceil(count / 2)))), 'aria-label': t('split.everyN') });
  const at = h('input.input.split-at', { type: 'text', placeholder: t('split.atPlaceholder'), 'aria-label': t('split.atPages'), autocomplete: 'off' });
  const options = h('fieldset.split-options', h('legend.field-label', t('split.how')),
    radio('every', 'split.every', h('span.split-inline', every, h('span', t('split.pagesEach')))),
    radio('at', 'split.at', at),
    radio('bookmarks', starts.length ? 'split.bookmarks' : 'split.noBookmarks',
      starts.length ? h('span.muted', tn('split.bookmarkCount', starts.length)) : null, !starts.length));
  const preview = h('p.split-preview', { 'aria-live': 'polite' });
  const error = h('p.field-error', { role: 'alert', hidden: true });
  const progress = createJobProgress({ onCancel: () => job?.cancel() });
  const cancelBtn = h('button.btn', { type: 'button', onclick: () => modal.close() }, t('common.cancel'));
  const runBtn = h('button.btn.primary', { type: 'button', onclick: () => run() }, icon('scissors'), t('split.run'));

  const modal = createModal({
    title: t('split.title', { name: tab.name }),
    className: 'split-dialog',
    body: [h('p.muted', tn('split.source', count, { name: tab.name })), options, preview, error],
    footer: [progress.el, h('span.dialog-spacer'), cancelBtn, runBtn],
    onCancel: () => modal.close(),
  });

  const mode = () => options.querySelector('input[name="split-mode"]:checked')?.value ?? 'every';
  const plan = () => planSplit({
    count,
    base,
    mode: mode(),
    every: every.value,
    at: at.value.split(/[\s,;]+/).filter(Boolean).map(Number),
    starts,
  });

  function update() {
    const p = plan();
    if (p.error) {
      preview.textContent = t(`split.error.${p.error}`, { n: count });
      preview.classList.add('invalid');
      runBtn.disabled = true;
      return p;
    }
    preview.classList.remove('invalid');
    const shown = p.parts.slice(0, 6).map((part) => (part.label ? `${part.label} (${part.range})` : part.range)).join(' · ');
    preview.textContent = `${tn('split.creates', p.parts.length)}: ${shown}${p.parts.length > 6 ? ' …' : ''}`;
    runBtn.disabled = !!job;
    return p;
  }
  options.addEventListener('input', update);
  options.addEventListener('change', update);
  every.addEventListener('focus', () => { options.querySelector('input[value="every"]').checked = true; update(); });
  at.addEventListener('focus', () => { options.querySelector('input[value="at"]').checked = true; update(); });

  async function run() {
    const p = update();
    if (p.error) return;
    modal.setBusy(true);
    runBtn.disabled = true;
    cancelBtn.hidden = true;
    error.hidden = true;
    progress.start(t('job.starting'));
    const bytes = tab.bytes.slice();
    job = runJob('split', { bytes, parts: p.parts.map(({ name, pages }) => ({ name, pages })) }, {
      transfer: [bytes.buffer],
      onProgress: ({ done, total, label }) => progress.set(done, total,
        label === 'zip' ? t('split.zipping') : label === 'done' ? t('job.done') : t('split.progress', { n: done + 1, total: total - 1 })),
    });
    try {
      const result = await job.promise;
      const zipName = `${base}-split.zip`;
      downloadBytes(result.zip, zipName, 'application/zip');
      modal.close();
      toast(tn('split.done', result.count, { name: zipName }));
    } catch (err) {
      if (err.name === 'JobCancelled') toast(t('job.cancelled'));
      else {
        error.textContent = t('split.failed', { message: err.message });
        error.hidden = false;
      }
    } finally {
      job = null;
      modal.setBusy(false);
      progress.stop();
      cancelBtn.hidden = false;
      update();
    }
  }

  update();
  return modal;
}
