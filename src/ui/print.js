// Print (⌘P): render the chosen pages at 150 or 300 dpi (pdf.js "print"
// intent: annotations meant for printing, form values) into images in a
// hidden iframe, one page per sheet at the page's own size, then print it.
import { h } from './dom.js';
import { t } from '../i18n/index.js';
import { openDialog, createModal } from './dialog.js';
import { toast } from './toast.js';
import { canvasToBlob } from './canvas-encode.js';
import { parsePageRange } from '../core/page-range.js';

export class Printer {
  constructor(app) {
    this.app = app;
    this.busy = false;
    /** Replaceable (tests): hands the prepared frame to the browser's print. */
    this.printFrame = (iframe) => iframe.contentWindow.print();
  }

  async open() {
    const tab = this.app.activeTab;
    if (!tab) return toast(t('print.needsDocument'));
    if (this.busy) return;
    // Respect the document's own permissions (pdf.js reports the allowed flags).
    const perms = await tab.pdf.getPermissions().catch(() => null);
    const PRINT = tab.viewer.pdfjs.PermissionFlag?.PRINT ?? 4;
    if (perms && !(perms.has ? perms.has(PRINT) : perms.includes?.(PRINT))) return toast(t('print.notAllowed'), { kind: 'error' });
    const count = tab.pdf.numPages;
    const current = tab.viewer.current + 1;
    const range = h('input.input', { type: 'text', name: 'range', placeholder: t('print.rangePlaceholder'), autocomplete: 'off', disabled: true });
    const radio = (value, label, checked) => h('label.radio', h('input', { type: 'radio', name: 'which', value, checked }), label);
    const which = h('fieldset.radio-group', h('legend', t('print.pages')),
      radio('all', t('print.all', { n: count }), true),
      radio('current', t('print.current', { n: current })),
      radio('range', t('print.range')), range);
    which.addEventListener('change', () => {
      range.disabled = which.querySelector('input[value="range"]').checked === false;
      if (!range.disabled) range.focus();
    });
    const dpi = h('fieldset.radio-group', h('legend', t('print.quality')),
      h('label.radio', h('input', { type: 'radio', name: 'dpi', value: '150', checked: true }), t('print.dpi150')),
      h('label.radio', h('input', { type: 'radio', name: 'dpi', value: '300' }), t('print.dpi300')));
    const error = h('p.field-error', { role: 'alert' });
    const choice = await openDialog({
      title: t('print.title'),
      className: 'print-dialog',
      body: [which, dpi, error],
      actions: [{ label: t('common.cancel'), value: null }, { label: t('print.print'), primary: true }],
      onSubmit: (form) => {
        const f = new FormData(form);
        let pages;
        if (f.get('which') === 'current') pages = [current - 1];
        else if (f.get('which') === 'range') {
          const r = parsePageRange(range.value, count);
          if (r.error) {
            error.textContent = t('print.badRange', { part: r.error });
            return undefined;
          }
          pages = r.pages;
        } else pages = [...Array(count).keys()];
        return { pages, dpi: Number(f.get('dpi')) };
      },
    });
    if (!choice) return;
    await this.print(tab, choice);
  }

  /** Render pages into a hidden iframe and print it. Resolves the number of pages prepared. */
  async print(tab, { pages, dpi }) {
    this.busy = true;
    const status = h('p', { role: 'status' });
    const bar = h('progress', { max: pages.length, value: 0 });
    let cancelled = false;
    const modal = createModal({
      title: t('print.preparing'),
      body: [status, bar],
      footer: [h('button.btn', { type: 'button', onclick: () => { cancelled = true; } }, t('common.cancel'))],
      onCancel: () => { cancelled = true; },
    });
    const urls = [];
    const iframe = h('iframe.print-frame', { title: t('print.frameTitle'), 'aria-hidden': 'true', tabIndex: -1 });
    try {
      const pdfjs = tab.viewer.pdfjs;
      const sheets = [];
      for (const [k, index] of pages.entries()) {
        if (cancelled) return 0;
        status.textContent = t('print.progress', { n: k + 1, total: pages.length });
        bar.value = k;
        const proxy = await tab.pdf.getPage(index + 1);
        const unit = proxy.getViewport({ scale: 1 });
        const viewport = proxy.getViewport({ scale: dpi / 72 });
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.floor(viewport.width));
        canvas.height = Math.max(1, Math.floor(viewport.height));
        await proxy.render({ canvas, viewport, intent: 'print', annotationMode: pdfjs.AnnotationMode.ENABLE_STORAGE, background: '#ffffff' }).promise;
        const blob = await canvasToBlob(canvas, 'image/jpeg', { quality: 0.92, timeout: 4000 });
        canvas.width = 0;
        canvas.height = 0;
        const url = URL.createObjectURL(blob);
        urls.push(url);
        sheets.push({ url, w: unit.width / 72, h: unit.height / 72 });
      }
      if (cancelled) return 0;
      bar.value = pages.length;
      status.textContent = t('print.sending');
      document.body.append(iframe);
      const doc = iframe.contentDocument;
      const css = ['@page { margin: 0; }', 'html, body { margin: 0; padding: 0; background: #fff; }', 'img { display: block; break-after: page; }', 'img:last-child { break-after: auto; }'];
      sheets.forEach((s, i) => css.push(`@page p${i} { size: ${s.w}in ${s.h}in; margin: 0; }`, `#p${i} { page: p${i}; width: ${s.w}in; height: ${s.h}in; }`));
      doc.open();
      doc.write(`<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(tab.name)}</title><style>${css.join('\n')}</style></head><body></body></html>`);
      doc.close();
      await Promise.all(sheets.map((s, i) => new Promise((resolve) => {
        const img = doc.createElement('img');
        img.id = `p${i}`;
        img.alt = '';
        img.onload = resolve;
        img.onerror = resolve;
        img.src = s.url;
        doc.body.append(img);
      })));
      modal.close();
      await this.printFrame(iframe);
      return sheets.length;
    } catch (err) {
      toast(t('print.failed', { message: err.message }), { kind: 'error' });
      return 0;
    } finally {
      modal.close();
      this.busy = false;
      // Leave the frame long enough for the browser's print preview to read it.
      setTimeout(() => {
        iframe.remove();
        for (const u of urls) URL.revokeObjectURL(u);
      }, 60_000);
    }
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}
