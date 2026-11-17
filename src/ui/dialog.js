// Modal dialogs built on <dialog> (focus trap, Esc to cancel, ARIA for free).
import { h } from './dom.js';
import { t } from '../i18n/index.js';

let counter = 0;

/**
 * Open a modal dialog.
 * @param {object} o
 * @param {string} o.title
 * @param {Node|string|Array} o.body
 * @param {{label:string, value:any, primary?:boolean, danger?:boolean}[]} o.actions
 * @param {any} [o.cancelValue]   value when dismissed with Esc
 * @param {(form: HTMLFormElement) => any} [o.onSubmit]  primary action value
 * @param {string} [o.className]
 * @returns {Promise<any>}
 */
export function openDialog({ title, body, actions, cancelValue = null, onSubmit, className = '' }) {
  const id = `dialog-${++counter}`;
  return new Promise((resolve) => {
    let result = cancelValue;
    const buttons = actions.map((a) =>
      h(`button.btn${a.primary ? '.primary' : ''}${a.danger ? '.danger' : ''}`, {
        type: a.primary ? 'submit' : 'button',
        value: a.primary ? '' : undefined,
        dataset: { action: String(actions.indexOf(a)) },
        onclick: a.primary ? null : () => { result = a.value; dialog.close(); },
      }, a.label),
    );
    const form = h('form.dialog-form', { method: 'dialog' },
      h('h2.dialog-title', { id: `${id}-title` }, title),
      h('div.dialog-body', { id: `${id}-body` }, body),
      h('div.dialog-actions', buttons),
    );
    form.addEventListener('submit', (e) => {
      const primary = actions.find((a) => a.primary);
      result = onSubmit ? onSubmit(form) : primary?.value;
      if (result === undefined) e.preventDefault(); // onSubmit can veto
    });
    const dialog = h(`dialog.dialog${className ? '.' + className : ''}`, {
      'aria-labelledby': `${id}-title`,
      'aria-describedby': `${id}-body`,
    }, form);
    dialog.addEventListener('cancel', () => { result = cancelValue; });
    dialog.addEventListener('close', () => {
      dialog.remove();
      resolve(result);
    });
    document.body.append(dialog);
    dialog.showModal();
    const focus = dialog.querySelector('[autofocus]') ?? buttons.find((b) => b.type === 'submit') ?? buttons[0];
    focus?.focus();
  });
}

export function confirmDialog({ title, message, confirmLabel = t('common.ok'), cancelLabel = t('common.cancel'), danger = false }) {
  return openDialog({
    title,
    body: typeof message === 'string' ? h('p', message) : message,
    actions: [
      { label: cancelLabel, value: false },
      { label: confirmLabel, value: true, primary: true, danger },
    ],
    cancelValue: false,
  });
}

export function alertDialog({ title, message }) {
  return openDialog({
    title,
    body: typeof message === 'string' ? h('p', message) : message,
    actions: [{ label: t('common.ok'), value: true, primary: true }],
    cancelValue: true,
  });
}

/** Ask for a document password. Resolves to the password, or null if cancelled. */
export function promptPassword({ filename, retry }) {
  const input = h('input.input', {
    type: 'password',
    name: 'password',
    autocomplete: 'off',
    autofocus: true,
    'aria-label': t('password.label'),
    'aria-invalid': retry ? 'true' : null,
    'aria-describedby': retry ? 'password-error' : null,
  });
  return openDialog({
    title: t('password.title'),
    className: 'password-dialog',
    body: [
      h('p', t('password.message', { name: filename })),
      h('label.field', h('span.field-label', t('password.label')), input),
      retry ? h('p.field-error', { id: 'password-error', role: 'alert' }, t('password.incorrect')) : null,
    ],
    actions: [
      { label: t('common.cancel'), value: null },
      { label: t('password.open'), primary: true },
    ],
    cancelValue: null,
    onSubmit: () => input.value,
  });
}
