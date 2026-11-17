// Attachments panel: embedded files — open PDFs in a new tab, save others,
// add and remove (both undoable).
import { h } from '../dom.js';
import { icon } from '../icons.js';
import { t, tn } from '../../i18n/index.js';
import { implementPanel } from '../panels.js';
import { formatBytes } from '../format.js';
import { downloadBytes } from '../save.js';

const isPdf = (a) => /\.pdf$/i.test(a.filename) || (a.content?.length > 4 && String.fromCharCode(...a.content.slice(0, 5)) === '%PDF-');

export function registerAttachmentsPanel() {
  implementPanel('attachments', {
    render(container, tab, app) {
      let disposed = false;
      const input = h('input', { type: 'file', id: 'attach-file-input', hidden: true });
      const addBtn = h('button.btn.btn-sm', { type: 'button', onclick: () => input.click() }, icon('paperclip', { size: 14 }), t('attachments.add'));
      const count = h('span.muted.attachments-count');
      const list = h('ul.attachment-list', { 'aria-label': t('panel.attachments.label') });
      const body = h('div.attachments-body', list);
      container.append(h('div.panel-toolbar', addBtn, h('span.dialog-spacer'), count, input), body);

      input.addEventListener('change', async () => {
        const file = input.files?.[0];
        input.value = '';
        if (!file) return;
        const bytes = new Uint8Array(await file.arrayBuffer());
        await app.edit(tab, 'addAttachment', { name: file.name, bytes, mimeType: file.type || 'application/octet-stream' },
          t('step.addAttachment', { name: file.name }));
      });

      async function render() {
        // pdf.js 6: getAttachments() lists them; the bytes come separately.
        const map = await tab.pdf.getAttachments().catch(() => null);
        const items = await Promise.all([...(map ?? [])].map(async ([id, a]) => ({
          ...a,
          id,
          content: await tab.pdf.getAttachmentContent(id).catch(() => new Uint8Array()),
        })));
        if (disposed) return;
        const readOnly = !!tab.model.readOnly;
        addBtn.disabled = readOnly;
        count.textContent = items.length ? tn('attachments.count', items.length) : '';
        if (!items.length) {
          list.replaceChildren();
          body.replaceChildren(h('div.empty-state',
            h('div.empty-icon', icon('paperclip', { size: 22 })),
            h('p.empty-title', t('attachments.none')),
            h('p.empty-text', t('attachments.noneText'))), list);
          return;
        }
        body.replaceChildren(list);
        list.replaceChildren(...items.map((a) => {
          const pdf = isPdf(a);
          const open = h('button.btn.btn-sm', {
            type: 'button',
            onclick: () => (pdf
              ? app.openBytes(a.content.slice(), a.filename)
              : downloadBytes(a.content, a.filename, 'application/octet-stream')),
          }, icon(pdf ? 'externalLink' : 'download', { size: 14 }), pdf ? t('attachments.open') : t('attachments.save'));
          const remove = h('button.btn.icon-btn', {
            type: 'button',
            disabled: readOnly,
            'aria-label': t('attachments.remove', { name: a.filename }),
            title: t('attachments.remove', { name: a.filename }),
            onclick: () => app.edit(tab, 'removeAttachment', { name: a.id }, t('step.removeAttachment', { name: a.filename })),
          }, icon('trash', { size: 14 }));
          return h('li.attachment', { dataset: { name: a.filename } },
            h('div.attachment-icon', icon(pdf ? 'file' : 'paperclip')),
            h('div.attachment-text',
              h('span.attachment-name', a.filename),
              h('span.muted.attachment-meta', formatBytes(a.content?.length ?? 0)),
              a.description ? h('span.attachment-desc', a.description) : null),
            h('div.attachment-actions', open, remove));
        }));
      }

      const onChange = () => render();
      tab.addEventListener('docchange', onChange);
      tab.model.addEventListener('readonlychange', onChange);
      render();
      return () => {
        disposed = true;
        tab.removeEventListener('docchange', onChange);
        tab.model.removeEventListener('readonlychange', onChange);
      };
    },
  });
}
