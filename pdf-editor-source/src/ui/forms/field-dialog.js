// Field properties: name, required, default value (also becomes the current
// value), and the options of dropdowns / lists. Resolves with the changes for
// the setFieldProps op, or null.
import { h } from '../dom.js';
import { t } from '../../i18n/index.js';
import { openDialog } from '../dialog.js';

export async function openFieldDialog({ info, otherNames }) {
  const name = h('input.input', { type: 'text', id: 'field-prop-name', name: 'name', value: info.partialName, required: true, autocomplete: 'off', spellcheck: false, 'aria-describedby': 'field-prop-name-error' });
  // The error is described-by, not inside the label (that would change the field's name).
  const nameError = h('span.field-error', { role: 'alert', id: 'field-prop-name-error' });
  const required = h('input', { type: 'checkbox', name: 'required', checked: info.required });
  const tooltip = h('input.input', { type: 'text', name: 'tooltip', value: info.tooltip ?? '', autocomplete: 'off' });
  const rows = [
    h('div.field', h('label.field-label', { htmlFor: 'field-prop-name' }, t('fieldProps.name')), name, nameError),
    h('label.field', h('span.field-label', t('fieldProps.tooltip')), tooltip, h('span.field-help', t('fieldProps.tooltipHelp'))),
    h('label.check', required, t('fieldProps.required')),
  ];
  let defaultInput = null;
  let optionsInput = null;
  if (info.kind === 'text') {
    defaultInput = info.multiline ? h('textarea.input.field-textarea', { name: 'default', rows: 3 }) : h('input.input', { type: 'text', name: 'default' });
    defaultInput.value = info.defaultValue ?? '';
  } else if (info.kind === 'checkbox') {
    defaultInput = h('select.input', { name: 'default' },
      h('option', { value: 'off' }, t('fieldProps.unchecked')),
      h('option', { value: 'on' }, t('fieldProps.checked')));
    defaultInput.value = info.defaultValue ? 'on' : 'off';
  } else if (info.kind === 'dropdown' || info.kind === 'list') {
    optionsInput = h('textarea.input.field-textarea', { name: 'options', rows: 5, spellcheck: false });
    optionsInput.value = (info.options ?? []).join('\n');
    defaultInput = h('select.input', { name: 'default' });
    const fill = () => {
      const opts = optionsInput.value.split('\n').map((s) => s.trim()).filter(Boolean);
      const keep = defaultInput.value || info.defaultValue || '';
      defaultInput.replaceChildren(h('option', { value: '' }, t('fieldProps.none')), ...opts.map((o) => h('option', { value: o }, o)));
      defaultInput.value = opts.includes(keep) ? keep : '';
    };
    optionsInput.addEventListener('input', fill);
    fill();
    rows.push(h('label.field', h('span.field-label', t('fieldProps.options')), optionsInput, h('span.field-help', t('fieldProps.optionsHelp'))));
  }
  if (defaultInput) rows.push(h('label.field', h('span.field-label', t('fieldProps.default')), defaultInput, h('span.field-help', t('fieldProps.defaultHelp'))));

  return openDialog({
    title: t('fieldProps.title', { type: t(`fieldKind.${info.kind}`) }),
    className: 'field-dialog',
    body: rows,
    actions: [
      { label: t('common.cancel'), value: null },
      { label: t('fieldProps.apply'), primary: true },
    ],
    onSubmit: () => {
      const newName = name.value.trim();
      const error = !newName ? t('fieldProps.nameEmpty') : /\./.test(newName) ? t('fieldProps.nameDot') : otherNames.has(newName) ? t('fieldProps.nameTaken') : '';
      nameError.textContent = error;
      name.setAttribute('aria-invalid', String(!!error));
      if (error) {
        name.focus();
        return undefined;
      }
      const changes = {};
      if (newName !== info.partialName) changes.newName = newName;
      if (required.checked !== info.required) changes.required = required.checked;
      if (tooltip.value.trim() !== (info.tooltip ?? '').trim()) changes.tooltip = tooltip.value.trim();
      if (optionsInput) {
        const opts = optionsInput.value.split('\n').map((s) => s.trim()).filter(Boolean);
        if (opts.join('\n') !== (info.options ?? []).join('\n')) changes.options = opts;
      }
      if (defaultInput) {
        const v = info.kind === 'checkbox' ? defaultInput.value === 'on' : defaultInput.value;
        const before = info.kind === 'checkbox' ? !!info.defaultValue : info.defaultValue ?? '';
        if (v !== before) changes.defaultValue = v;
      }
      return changes;
    },
  });
}
