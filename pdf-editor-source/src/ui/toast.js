// Toast notifications (polite live region).
import { h } from './dom.js';
import { icon } from './icons.js';
import { t } from '../i18n/index.js';

let region = null;

function ensureRegion() {
  if (!region || !region.isConnected) {
    region = h('div.toasts', { role: 'status', 'aria-live': 'polite' });
    document.body.append(region);
  }
  return region;
}

/**
 * @param {string} message
 * @param {{ kind?: 'info'|'error'|'success', timeout?: number }} [o]
 */
export function toast(message, { kind = 'info', timeout = 4000 } = {}) {
  const close = h('button.btn.icon-btn.toast-close', { type: 'button', 'aria-label': t('common.dismiss') }, icon('x', { size: 14 }));
  const el = h(`div.toast.${kind}`, { role: kind === 'error' ? 'alert' : null },
    kind === 'error' ? icon('alertTriangle') : null, h('span.toast-text', message), close);
  const remove = () => {
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 160);
  };
  close.addEventListener('click', remove);
  ensureRegion().append(el);
  if (timeout) setTimeout(remove, timeout);
  return { close: remove, el };
}
