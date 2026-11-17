// Progress bar + Cancel for a running job, shown in a dialog footer.
import { h } from '../dom.js';
import { t } from '../../i18n/index.js';

export function createJobProgress({ onCancel }) {
  const fill = h('div.progress-fill');
  const bar = h('div.progress-bar.job-bar', {
    role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': '0', 'aria-label': t('job.progress'),
  }, fill);
  const text = h('span.job-text', { 'aria-live': 'polite' });
  const cancel = h('button.btn', { type: 'button', onclick: () => onCancel() }, t('common.cancel'));
  const el = h('div.job-progress', { hidden: true }, h('div.job-status', text, bar), cancel);
  return {
    el,
    cancel,
    start(label) {
      el.hidden = false;
      text.textContent = label;
      this.set(0, 1);
    },
    set(done, total, label) {
      const pct = Math.round((100 * done) / Math.max(1, total));
      fill.style.width = `${pct}%`;
      bar.setAttribute('aria-valuenow', String(pct));
      if (label) text.textContent = label;
    },
    stop() {
      el.hidden = true;
    },
  };
}
