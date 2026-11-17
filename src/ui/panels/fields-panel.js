// Fields panel: every form field with name, type and value, in page / tab
// order; click (or Enter) to jump to it and focus it. "Highlight fields" and
// the Prepare form / Add signature entry points live here too.
import { h } from '../dom.js';
import { icon } from '../icons.js';
import { t, tn } from '../../i18n/index.js';
import { implementPanel } from '../panels.js';

const KIND_ICONS = { text: 'textInput', checkbox: 'checkSquare', radio: 'circleDot', dropdown: 'listDown', list: 'list', signature: 'signature', button: 'square' };

function summary(field) {
  const v = field.value;
  switch (field.kind) {
    case 'checkbox': return v ? t('fields.checked') : t('fields.unchecked');
    case 'radio': return v || t('fields.noneSelected');
    case 'dropdown':
    case 'list': {
      const list = Array.isArray(v) ? v : v ? [v] : [];
      return list.length ? list.join(', ') : t('fields.noneSelected');
    }
    case 'signature': return t('fields.signatureValue');
    case 'button': return t('fields.buttonValue');
    default: return v ? String(v).replace(/\s+/g, ' ') : t('fields.empty');
  }
}

export function registerFieldsPanel() {
  implementPanel('fields', {
    render(container, tab, app) {
      const forms = app.forms;
      let disposed = false;
      const highlight = h('input', { type: 'checkbox', checked: forms.highlight, onchange: () => forms.setHighlight(highlight.checked) });
      const count = h('span.muted.fields-count', { role: 'status' });
      const prepare = h('button.btn.btn-sm', { type: 'button', onclick: () => app.formEditor.activate('select') }, icon('squarePlus', { size: 14 }), t('fields.prepare'));
      const sign = h('button.btn.btn-sm', { type: 'button', onclick: () => forms.startSigning() }, icon('signature', { size: 14 }), t('fields.sign'));
      const list = h('div.fields-list', { role: 'list', 'aria-label': t('panel.fields.label') });
      const body = h('div.fields-body', list);
      container.append(
        h('div.panel-toolbar', h('label.check', highlight, t('fields.highlight')), h('span.dialog-spacer'), count),
        h('div.panel-toolbar.fields-actions', prepare, sign),
        body);

      function row(field) {
        const label = t(`fieldKind.${field.kind}`);
        const el = h('div.field-row', {
          role: 'listitem',
          tabIndex: 0,
          dataset: { fieldName: field.name, kind: field.kind },
          'aria-label': t('fields.rowLabel', { name: field.name, type: label, value: summary(field) }),
          onclick: () => activate(field),
          onkeydown: (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              activate(field);
            }
          },
        },
        h('span.field-row-icon', icon(KIND_ICONS[field.kind] ?? 'textInput', { size: 14 })),
        h('span.field-row-text',
          h('span.field-row-name', field.name, field.required ? h('span.field-required', { title: t('fields.required') }, ' *') : null),
          h('span.field-row-meta.muted', `${label} · ${t('fields.page', { label: tab.viewer.pageLabel(field.page) })}`),
          h('span.field-row-value', { title: summary(field) }, summary(field))),
        field.readOnly ? h('span.badge', t('fields.readOnly')) : null);
        if (app.formEditor.selection?.name === field.name) el.classList.add('selected');
        return el;
      }

      async function activate(field) {
        if (app.formEditor.tool) {
          const w = field.widgets[0];
          tab.viewer.goToPage(w.page + 1);
          await tab.viewer.whenAnnotations(w.page);
          app.formEditor.select(w.page, w.id, field.name);
          return;
        }
        if (field.kind === 'signature') {
          const w = field.widgets[0];
          tab.viewer.goToPage(w.page + 1);
          forms.signField(tab, { page: w.page, rect: w.rect, name: field.name });
          return;
        }
        await forms.focusField(tab, field);
      }

      function draw() {
        if (disposed) return;
        const fields = tab.fields ?? [];
        const readOnly = !!tab.model.readOnly;
        prepare.disabled = readOnly;
        sign.disabled = readOnly;
        count.textContent = fields.length ? tn('fields.count', fields.length) : '';
        if (!fields.length) {
          body.replaceChildren(h('div.empty-state',
            h('div.empty-icon', icon('textInput', { size: 22 })),
            h('p.empty-title', t('fields.none')),
            h('p.empty-text', t('fields.noneText'))));
          return;
        }
        list.replaceChildren(...fields.map(row));
        body.replaceChildren(list);
      }

      const onFields = (e) => {
        if (e.detail.tab === tab) draw();
      };
      const onHighlight = () => {
        highlight.checked = forms.highlight;
      };
      const onSelect = () => {
        for (const el of list.querySelectorAll('.field-row')) {
          const on = app.formEditor.selection?.name === el.dataset.fieldName;
          el.classList.toggle('selected', on);
          if (on) el.scrollIntoView({ block: 'nearest' });
        }
      };
      forms.addEventListener('fieldschange', onFields);
      forms.addEventListener('highlightchange', onHighlight);
      app.formEditor.addEventListener('selectionchange', onSelect);
      tab.model.addEventListener('readonlychange', draw);
      if (tab.fields) draw();
      (tab.fieldsPromise ?? forms.loadFields(tab)).then(draw);
      return () => {
        disposed = true;
        forms.removeEventListener('fieldschange', onFields);
        forms.removeEventListener('highlightchange', onHighlight);
        app.formEditor.removeEventListener('selectionchange', onSelect);
        tab.model.removeEventListener('readonlychange', draw);
      };
    },
  });
}
