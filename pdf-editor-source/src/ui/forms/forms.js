// Forms controller (app.forms): field commits → undo steps, the field list
// for the Fields panel, "Highlight fields", signatures and flattening.
import { h } from '../dom.js';
import { t } from '../../i18n/index.js';
import { toast } from '../toast.js';
import { confirmDialog } from '../dialog.js';
import { getPref, setPref } from '../../core/prefs.js';
import { authorName } from '../../core/settings.js';
import { widgetValue, kindOf } from '../../view/form-layer.js';
import { pageGeometry, SIGNATURE_CONTENTS } from '../annotate/annotator.js';
import { openSignatureDialog } from './signature-dialog.js';

const BATCH = 16;

export class Forms extends EventTarget {
  constructor(app) {
    super();
    this.app = app;
    this.highlight = getPref('forms.highlight', true);
    this.placer = null;
    app.addEventListener('documentopened', (e) => this.attach(e.detail.tab));
  }

  attach(tab) {
    const viewer = tab.viewer;
    viewer.formsReadOnly = !!tab.model.readOnly;
    tab.model.addEventListener('readonlychange', () => {
      viewer.formsReadOnly = !!tab.model.readOnly;
    });
    viewer.addEventListener('fieldcommit', (e) => this.commit(tab, e.detail));
    viewer.addEventListener('fieldsign', (e) => this.signField(tab, e.detail));
    tab.addEventListener('docchange', () => this.loadFields(tab));
    tab.host.classList.toggle('highlight-fields', this.highlight);
    this.loadFields(tab);
  }

  // ------------------------------------------------------------ fields

  /**
   * Every field of the document: [{ name, kind, page, id, widgets, value,
   * required, readOnly, options }] in page / tab order.
   */
  loadFields(tab) {
    const seq = (tab.fieldsSeq ?? 0) + 1;
    tab.fieldsSeq = seq;
    tab.fieldsPromise = (async () => {
      const objects = await tab.pdf.getFieldObjects().catch(() => null);
      const pages = new Set();
      for (const list of objects?.values?.() ?? Object.values(objects ?? {})) {
        for (const w of list) if (w.page >= 0) pages.add(w.page);
      }
      const sorted = [...pages].sort((a, b) => a - b);
      const widgets = [];
      for (let i = 0; i < sorted.length; i += BATCH) {
        const chunk = await Promise.all(sorted.slice(i, i + BATCH).map(async (p) => {
          try {
            const proxy = await tab.pdf.getPage(p + 1);
            return (await proxy.getAnnotations()).filter((a) => a.subtype === 'Widget' && a.fieldName).map((a) => ({ ...a, page: p }));
          } catch {
            return [];
          }
        }));
        widgets.push(...chunk.flat());
      }
      const byName = new Map();
      for (const w of widgets) {
        let f = byName.get(w.fieldName);
        if (!f) {
          f = {
            name: w.fieldName,
            kind: kindOf(w) === 'choice' ? (w.combo ? 'dropdown' : 'list') : kindOf(w),
            page: w.page,
            id: w.id,
            widgets: [],
            value: widgetValue(w),
            required: !!w.required,
            readOnly: !!w.readOnly,
            options: w.options?.map((o) => o.displayValue) ?? null,
            multiline: !!w.multiLine,
          };
          byName.set(w.fieldName, f);
        }
        f.widgets.push({ id: w.id, page: w.page, rect: [...w.rect], buttonValue: w.buttonValue });
        if (f.kind === 'radio' && widgetValue(w)) f.value = widgetValue(w);
      }
      const fields = [...byName.values()];
      if (tab.fieldsSeq === seq) {
        tab.viewer.setFieldPages(sorted);
        tab.fields = fields;
        this.dispatchEvent(new CustomEvent('fieldschange', { detail: { tab } }));
      }
      return fields;
    })();
    return tab.fieldsPromise;
  }

  async commit(tab, { name, value }) {
    const ok = await this.app.edit(tab, 'setFieldValues', { values: [{ name, value }] }, t('step.fillField', { name }));
    if (!ok) tab.viewer.refreshForms();
  }

  /** Focus a field's control on its page. */
  async focusField(tab, field) {
    const w = field.widgets[0];
    return tab.viewer.focusField(field.name, w.page);
  }

  setHighlight(on) {
    this.highlight = !!on;
    setPref('forms.highlight', this.highlight);
    for (const tab of this.app.tabs) tab.host.classList.toggle('highlight-fields', this.highlight);
    this.dispatchEvent(new CustomEvent('highlightchange'));
  }

  /** Start filling: Fields panel + the first field focused. */
  async startFilling() {
    const tab = this.app.activeTab;
    if (!tab) return toast(t('forms.needsDocument'));
    this.app.showPanel('fields');
    const fields = await (tab.fieldsPromise ?? this.loadFields(tab));
    const first = fields.find((f) => !f.readOnly && f.kind !== 'button' && f.kind !== 'signature');
    if (!first) return toast(t('forms.noFields'));
    await this.focusField(tab, first);
  }

  async flatten() {
    const tab = this.app.editableTab();
    if (!tab) return;
    const fields = await (tab.fieldsPromise ?? this.loadFields(tab));
    if (!fields.length) return toast(t('forms.noFields'));
    const ok = await confirmDialog({ title: t('forms.flattenTitle'), message: t('forms.flattenMessage', { n: fields.length }), confirmLabel: t('forms.flatten') });
    if (!ok) return;
    if (await this.app.edit(tab, 'flattenForm', {}, t('step.flattenForm'))) toast(t('forms.flattened'));
  }

  // -------------------------------------------------------- signatures

  /** Sign a signature field: the signature fills the field's box. */
  async signField(tab, { page, rect, name }) {
    if (tab.model.readOnly) return toast(t(`edit.readOnly.${tab.model.readOnly}`), { kind: 'error' });
    const sig = await openSignatureDialog();
    if (!sig) return;
    const [x0, y0, x1, y1] = [Math.min(rect[0], rect[2]), Math.min(rect[1], rect[3]), Math.max(rect[0], rect[2]), Math.max(rect[1], rect[3])];
    const inset = 2;
    const bw = x1 - x0 - inset * 2;
    const bh = y1 - y0 - inset * 2;
    const k = Math.min(bw / sig.width, bh / sig.height);
    const w = sig.width * k;
    const hh = sig.height * k;
    const fx = x0 + inset + (bw - w) / 2;
    const fy = y0 + inset + (bh - hh) / 2;
    await this.placeSignature(tab, page, [fx, fy, fx + w, fy + hh], sig, t('step.signField', { name }));
  }

  /** "Add signature": pick one, then click on a page to place it. */
  async startSigning() {
    const tab = this.app.activeTab;
    if (!tab) return toast(t('forms.needsDocument'));
    if (tab.model.readOnly) return toast(t(`edit.readOnly.${tab.model.readOnly}`), { kind: 'error' });
    const sig = await openSignatureDialog();
    if (!sig) return;
    this.app.annotator?.deactivate();
    this.app.formEditor?.deactivate();
    this.startPlacing(tab, sig);
  }

  async placeSignature(tab, page, rect, sig, label = t('step.addSignature')) {
    const result = await this.app.edit(tab, 'addSignature', {
      page, rect, png: sig.png, author: authorName() || t('comments.anonymous'), contents: SIGNATURE_CONTENTS,
    }, label);
    const id = result?.id;
    if (id && this.app.annotator) {
      this.app.annotator.activate('select');
      this.app.annotator.select(page, id);
    }
    return id;
  }

  /** Placement mode: a preview follows the pointer; click places, Esc cancels. */
  startPlacing(tab, sig) {
    this.cancelPlacing();
    const viewer = tab.viewer;
    const url = URL.createObjectURL(new Blob([sig.png], { type: 'image/png' }));
    const ghost = h('img.sig-ghost', { src: url, alt: '', 'aria-hidden': 'true' });
    // Default size: 150 pt wide, at most 60 pt high.
    let wPt = 150;
    let hPt = (wPt * sig.height) / sig.width;
    if (hPt > 60) {
      hPt = 60;
      wPt = (hPt * sig.width) / sig.height;
    }
    const hint = h('div.sig-place-hint', { role: 'status' }, t('sign.placeHint'));
    tab.host.append(hint);
    tab.host.classList.add('placing-signature');
    const pageOf = (target) => {
      const el = target.closest?.('.page');
      return el && tab.host.contains(el) ? viewer.views[Number(el.dataset.pageNumber) - 1] : null;
    };
    const move = (e) => {
      const view = pageOf(e.target);
      if (!view) {
        ghost.remove();
        return;
      }
      const s = viewer.layout.scale;
      const r = view.el.getBoundingClientRect();
      Object.assign(ghost.style, {
        width: `${wPt * s}px`,
        height: `${hPt * s}px`,
        left: `${e.clientX - r.left - (wPt * s) / 2}px`,
        top: `${e.clientY - r.top - (hPt * s) / 2}px`,
      });
      if (ghost.parentNode !== view.el) view.el.append(ghost);
    };
    const down = async (e) => {
      if (e.button !== 0) return;
      const view = pageOf(e.target);
      if (!view?.baseViewport) return;
      e.preventDefault();
      e.stopPropagation();
      const g = pageGeometry(viewer, view);
      const s = viewer.layout.scale;
      const [x, y] = g.local(e.clientX, e.clientY);
      const box = [x - (wPt * s) / 2, y - (hPt * s) / 2, x + (wPt * s) / 2, y + (hPt * s) / 2];
      this.cancelPlacing();
      await this.placeSignature(tab, view.index, g.cssToPdfRect(box), sig);
    };
    const key = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        this.cancelPlacing();
      }
    };
    tab.host.addEventListener('pointermove', move);
    tab.host.addEventListener('pointerdown', down, true);
    document.addEventListener('keydown', key, true);
    const onTab = () => this.cancelPlacing();
    this.app.addEventListener('tabchange', onTab);
    this.placer = {
      cancel: () => {
        tab.host.removeEventListener('pointermove', move);
        tab.host.removeEventListener('pointerdown', down, true);
        document.removeEventListener('keydown', key, true);
        this.app.removeEventListener('tabchange', onTab);
        tab.host.classList.remove('placing-signature');
        ghost.remove();
        hint.remove();
        URL.revokeObjectURL(url);
      },
    };
  }

  cancelPlacing() {
    const p = this.placer;
    this.placer = null;
    p?.cancel();
  }
}
