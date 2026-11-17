// Document Properties panel: editable title/author/subject/keywords (one
// undo step), plus read-only facts: producer, dates, version, pages and
// sizes, fonts, tagging, fields, layers, attachments, security.
import { h } from '../dom.js';
import { icon } from '../icons.js';
import { t, tn } from '../../i18n/index.js';
import { implementPanel } from '../panels.js';
import { formatBytes } from '../format.js';
import { getPdfjs } from '../../view/pdfjs.js';

const NAMED_SIZES = [
  ['A3', 841.89, 1190.55], ['A4', 595.28, 841.89], ['A5', 419.53, 595.28],
  ['Letter', 612, 792], ['Legal', 612, 1008], ['Tabloid', 792, 1224],
];

/** "A4 portrait" / "Letter landscape" / "400 × 400 pt (5.56 × 5.56 in)" */
export function describeSize(w, h) {
  const tol = 3;
  for (const [name, a, b] of NAMED_SIZES) {
    if (Math.abs(w - a) < tol && Math.abs(h - b) < tol) return t('props.sizePortrait', { name });
    if (Math.abs(w - b) < tol && Math.abs(h - a) < tol) return t('props.sizeLandscape', { name });
  }
  const inch = (v) => (v / 72).toFixed(2).replace(/\.?0+$/, '');
  const mm = (v) => Math.round((v / 72) * 25.4);
  return t('props.sizeCustom', { w: inch(w), h: inch(h), wmm: mm(w), hmm: mm(h) });
}

const PERMISSIONS = [
  [4, 'print'], [2048, 'printHigh'], [8, 'modify'], [16, 'copy'], [512, 'accessibility'],
  [32, 'annotate'], [256, 'fillForms'], [1024, 'assemble'],
];

export function registerPropertiesPanel() {
  implementPanel('properties', {
    render(container, tab, app) {
      let disposed = false;
      const body = h('div.props-body');
      container.append(body);

      async function render() {
        const pdfjs = await getPdfjs();
        const pdf = tab.pdf;
        const [meta, perms, mark, fields, attachments, oc] = await Promise.all([
          pdf.getMetadata().catch(() => ({ info: {} })),
          pdf.getPermissions().catch(() => null),
          pdf.getMarkInfo().catch(() => null),
          pdf.getFieldObjects().catch(() => null),
          pdf.getAttachments().catch(() => null),
          tab.viewer.ocConfigPromise,
        ]);
        await tab.viewer.sizesLoaded;
        if (disposed) return;
        const info = meta.info ?? {};
        const readOnly = tab.model.readOnly;
        const date = (s) => {
          const d = s ? pdfjs.PDFDateString.toDateObject(s) : null;
          return d ? d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : t('props.unknown');
        };

        // ---- Description (editable)
        const field = (name, labelKey, value, multiline = false) => {
          const input = h(multiline ? 'textarea.input.props-input' : 'input.input.props-input', {
            name, value: value ?? '', disabled: !!readOnly, autocomplete: 'off', rows: multiline ? '2' : null,
          });
          if (multiline) input.value = value ?? '';
          return h('label.field', h('span.field-label', t(labelKey)), input);
        };
        const form = h('form.props-form', { 'aria-label': t('props.description') },
          field('title', 'props.title', info.Title),
          field('author', 'props.author', info.Author),
          field('subject', 'props.subject', info.Subject, true),
          field('keywords', 'props.keywords', info.Keywords),
        );
        const apply = h('button.btn.primary.btn-sm', { type: 'submit', disabled: true }, t('props.apply'));
        const revert = h('button.btn.btn-sm', { type: 'button', disabled: true, onclick: () => render() }, t('props.revert'));
        form.append(readOnly
          ? h('p.muted.props-note', t(`edit.readOnly.${readOnly}`))
          : h('div.props-actions', revert, apply));
        const initial = JSON.stringify(Object.fromEntries(new FormData(form)));
        form.addEventListener('input', () => {
          const changed = JSON.stringify(Object.fromEntries(new FormData(form))) !== initial;
          apply.disabled = !changed;
          revert.disabled = !changed;
        });
        form.addEventListener('submit', async (e) => {
          e.preventDefault();
          const values = Object.fromEntries(new FormData(form));
          apply.disabled = true;
          await app.edit(tab, 'setMetadata', values, t('step.editProperties'));
        });

        // ---- Facts
        const rows = (pairs) => h('dl.props-list', pairs.filter(Boolean).flatMap(([k, v]) => [h('dt', t(k)), h('dd', v)]));
        const sizes = new Map();
        tab.viewer.sizes.forEach((s) => {
          const turned = (s.rotate ?? 0) % 180 !== 0;
          const label = describeSize(turned ? s.h : s.w, turned ? s.w : s.h);
          sizes.set(label, (sizes.get(label) ?? 0) + 1);
        });
        const sizeText = sizes.size === 1
          ? [...sizes.keys()][0]
          : h('ul.props-sizes', [...sizes].map(([label, n]) => h('li', `${label} × ${n}`)));
        const fieldCount = fields ? fields.size ?? Object.keys(fields).length : 0;
        const layerCount = oc ? [...oc].length : 0;
        const attachmentCount = attachments ? attachments.size ?? Object.keys(attachments).length : 0;
        const panelLink = (n, key, panel) => (n
          ? h('button.btn-link', { type: 'button', onclick: () => app.showPanel(panel) }, tn(key, n))
          : t('props.none'));

        const facts = rows([
          ['props.fileName', tab.name],
          ['props.fileSize', formatBytes(tab.bytes.length)],
          ['props.pdfVersion', info.PDFFormatVersion ?? t('props.unknown')],
          ['props.pages', String(pdf.numPages)],
          ['props.pageSize', sizeText],
          ['props.producer', info.Producer || t('props.unknown')],
          ['props.creator', info.Creator || t('props.unknown')],
          ['props.created', date(info.CreationDate)],
          ['props.modified', date(info.ModDate)],
          ['props.tagged', mark?.Marked ? t('props.yes') : t('props.no')],
          ['props.language', info.Language || t('props.unknown')],
          ['props.fastWebView', info.IsLinearized ? t('props.yes') : t('props.no')],
          ['props.fields', panelLink(fieldCount, 'props.fieldCount', 'fields')],
          ['props.layers', panelLink(layerCount, 'props.layerCount', 'layers')],
          ['props.attachments', panelLink(attachmentCount, 'props.attachmentCount', 'attachments')],
        ]);

        // ---- Security
        const encrypted = !!info.EncryptFilterName;
        const permList = perms
          ? h('ul.props-perms', PERMISSIONS.map(([flag, key]) => {
            const ok = perms.has ? perms.has(flag) : perms.includes(flag);
            return h(`li.${ok ? 'allowed' : 'denied'}`, icon(ok ? 'check' : 'x', { size: 12 }),
              h('span', t(`props.perm.${key}`)), h('span.visually-hidden', ok ? t('props.allowed') : t('props.notAllowed')));
          }))
          : t('props.noRestrictions');
        const security = rows([
          ['props.encrypted', encrypted
            ? t(tab.password ? 'props.encryptedPassword' : 'props.encryptedOwner', { filter: info.EncryptFilterName })
            : t('props.no')],
          ['props.permissions', permList],
        ]);

        // ---- Fonts (loaded from the pdf-lib worker)
        const fontsBody = h('div.props-fonts', h('p.muted', t('props.fontsLoading')));
        const section = (titleKey, content, open = true) => h('details.props-section', { open },
          h('summary', t(titleKey)), content);
        body.replaceChildren(
          section('props.description', form),
          section('props.document', facts),
          section('props.fontsTitle', fontsBody),
          section('props.security', security),
        );

        if (readOnly) {
          fontsBody.replaceChildren(h('p.muted', t('props.fontsUnavailable')));
        } else {
          tab.model.query('inspectFonts', {}).then((res) => {
            if (disposed) return;
            const fonts = res?.fonts ?? [];
            fontsBody.replaceChildren(fonts.length
              ? h('ul.font-list', fonts.map((f) => h('li.font-item',
                h('span.font-name', f.name),
                h('span.muted.font-type', f.type),
                h(`span.badge.font-embed${f.embedded ? '.embedded' : '.missing'}`,
                  f.embedded ? (f.subset ? t('props.fontSubset') : t('props.fontEmbedded')) : t('props.fontNotEmbedded')))))
              : h('p.muted', t('props.noFonts')));
          }, () => fontsBody.replaceChildren(h('p.muted', t('props.fontsUnavailable'))));
        }
      }

      const onChange = () => render();
      tab.addEventListener('docchange', onChange);
      tab.addEventListener('rename', onChange);
      tab.model.addEventListener('readonlychange', onChange);
      render();
      return () => {
        disposed = true;
        tab.removeEventListener('docchange', onChange);
        tab.removeEventListener('rename', onChange);
        tab.model.removeEventListener('readonlychange', onChange);
      };
    },
  });
}
