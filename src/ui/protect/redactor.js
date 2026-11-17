// Redaction (app.redactor). Marks are Redact annotations (reviewable on the
// page and in the Comments panel, removable like any annotation). Marks come
// from drawing an area, selecting text, or "Mark all matches" of a search.
// "Apply redactions" renders each marked page at 200 dpi with black boxes
// burned into the pixels and replaces the page's content with that image
// (core/ops/protect-ops.js) — one undo step, after a clear warning.
import { h } from '../dom.js';
import { icon } from '../icons.js';
import { t, tn } from '../../i18n/index.js';
import { toast } from '../toast.js';
import { confirmDialog, createModal } from '../dialog.js';
import { canvasToBlob } from '../canvas-encode.js';
import { pageGeometry, selectionQuads } from '../annotate/annotator.js';
import { buildQuery, findInText } from '../../view/text-index.js';

export const REDACT_DPI = 200;
const norm = (r) => [Math.min(r[0], r[2]), Math.min(r[1], r[3]), Math.max(r[0], r[2]), Math.max(r[1], r[3])];

/**
 * Where a search matches, as QuadPoints per page. Character positions inside
 * a text item are estimated from its width, so each quad is padded a little:
 * redaction errs on covering slightly more.
 */
export async function findMatchQuads(pdf, re, onProgress) {
  const out = [];
  for (let i = 0; i < pdf.numPages; i++) {
    onProgress?.(i, pdf.numPages);
    let content;
    try {
      content = await (await pdf.getPage(i + 1)).getTextContent({ disableNormalization: true });
    } catch {
      continue;
    }
    let text = '';
    const items = [];
    for (const item of content.items) {
      if (item.str === undefined) continue;
      items.push({ start: text.length, item });
      text += item.str;
      if (item.hasEOL) text += ' ';
    }
    const quads = [];
    for (const [s, e] of findInText(text, re)) {
      for (const { start, item } of items) {
        const len = item.str.length;
        const a = Math.max(s, start);
        const b = Math.min(e, start + len);
        if (a >= b || !len) continue;
        const family = content.styles?.[item.fontName]?.fontFamily ?? 'sans-serif';
        quads.push(itemQuad(item, a - start, b - start, family));
      }
    }
    if (quads.length) out.push({ page: i, quads });
  }
  return out;
}

let measureCtx = null;
/** Width of `str` in a browser font, for proportions only. */
function measure(str, family) {
  measureCtx ??= document.createElement('canvas').getContext('2d');
  measureCtx.font = `100px ${family}`;
  return measureCtx.measureText(str).width;
}

/**
 * The quad covering characters [i0, i1) of a text item. Where they start and
 * end is estimated from how wide that part of the string is in a similar
 * browser font, as a share of the item's real width — then padded by a
 * generous half character on each side, so a match is never under-covered.
 */
function itemQuad(item, i0, i1, family) {
  const [a, b, c, d, x, y] = item.transform;
  const str = item.str;
  const len = str.length;
  const fontH = Math.hypot(c, d) || item.height || 10;
  const total = measure(str, family) || len;
  const k = item.width / total;
  const avg = item.width / len;
  const pad = Math.max(avg * 0.5, fontH * 0.15);
  const u0 = Math.max(-1, measure(str.slice(0, i0), family) * k - pad);
  const u1 = Math.min(item.width + 1, measure(str.slice(0, i1), family) * k + pad);
  const v0 = -fontH * 0.3;
  const v1 = fontH * 1.0;
  // Text direction (unit vector) and its normal, for rotated text.
  const scale = Math.hypot(a, b) || 1;
  const ux = a / scale;
  const uy = b / scale;
  const p = (u, v) => [x + u * ux - v * uy, y + u * uy + v * ux];
  const pts = [p(u0, v1), p(u1, v1), p(u0, v0), p(u1, v0)];
  if (Math.abs(uy) < 0.01) return pts.flat();
  // Rotated text: the axis-aligned box around it.
  const xs = pts.map((q) => q[0]);
  const ys = pts.map((q) => q[1]);
  const [x0, y0, x1, y1] = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  return [x0, y1, x1, y1, x0, y0, x1, y0];
}

/** Black boxes for a page's marks, burned into a 200 dpi render. Resolves { jpg, view }. */
export async function renderRedactedPage(pdfjs, pdf, page, rects) {
  const proxy = await pdf.getPage(page + 1);
  const viewport = proxy.getViewport({ scale: REDACT_DPI / 72, rotation: 0 });
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(viewport.width));
  canvas.height = Math.max(1, Math.round(viewport.height));
  // Page content only: annotations stay annotations (the ones over redacted
  // areas are removed by the op), so nothing is drawn twice.
  await proxy.render({ canvas, viewport, annotationMode: pdfjs.AnnotationMode.DISABLE, background: '#ffffff' }).promise;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#000';
  for (const r of rects) {
    const p0 = viewport.convertToViewportPoint(r[0], r[1]);
    const p1 = viewport.convertToViewportPoint(r[2], r[3]);
    const [x0, y0, x1, y1] = norm([p0[0], p0[1], p1[0], p1[1]]);
    ctx.fillRect(Math.floor(x0) - 1, Math.floor(y0) - 1, Math.ceil(x1 - x0) + 2, Math.ceil(y1 - y0) + 2);
  }
  const blob = await canvasToBlob(canvas, 'image/jpeg', { quality: 0.9, timeout: 4000 });
  canvas.width = 0;
  canvas.height = 0;
  return { jpg: new Uint8Array(await blob.arrayBuffer()), view: [...proxy.view] };
}

export class Redactor extends EventTarget {
  constructor(app) {
    super();
    this.app = app;
    this.active = false;
    this.tool = 'area';
    this.marks = [];
    this.toolbar = this.buildToolbar();
    app.shell.main.append(this.toolbar.el);
    app.shell.main.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    document.addEventListener('mouseup', () => {
      if (this.active && this.tool === 'text') setTimeout(() => this.markSelection(), 0);
    });
    app.addEventListener('tabchange', () => {
      if (!this.tab) this.deactivate();
      else {
        this.syncHost();
        this.refresh();
      }
    });
    app.addEventListener('organizerchange', () => {
      if (app.organizerOpen) this.deactivate();
    });
    app.addEventListener('documentopened', (e) => {
      e.detail.tab.addEventListener('docchange', () => {
        if (this.active && e.detail.tab === this.tab) this.refresh();
      });
    });
  }

  get tab() {
    return this.app.activeTab;
  }

  activate(tool = this.tool) {
    const tab = this.app.editableTab();
    if (!tab) return;
    this.app.closeOrganizer?.();
    this.app.annotator?.deactivate();
    this.app.formEditor?.deactivate();
    this.app.forms?.cancelPlacing();
    this.active = true;
    this.tool = tool;
    this.syncHost();
    this.toolbar.show();
    this.toolbar.sync();
    this.refresh();
    this.dispatchEvent(new CustomEvent('change'));
  }

  deactivate() {
    if (!this.active) return;
    this.active = false;
    this.cancelDraft?.();
    this.syncHost();
    this.toolbar.hide();
    this.app.annotator?.deselect();
    this.dispatchEvent(new CustomEvent('change'));
  }

  syncHost() {
    for (const tab of this.app.tabs) {
      const on = this.active && tab === this.tab;
      tab.host.classList.toggle('redacting', on);
      tab.host.classList.toggle('redact-area', on && this.tool === 'area');
    }
  }

  async refresh() {
    const tab = this.tab;
    if (!tab) return;
    this.marks = await tab.model.query('listRedactions', {}).catch(() => []);
    this.toolbar.sync();
  }

  // ------------------------------------------------------------ marking

  async mark(items, label) {
    const tab = this.tab;
    const result = await this.app.edit(tab, 'addAnnotations', { items: items.map(({ page, quads, rect }) => ({ page, spec: { type: 'redact', quads, rect, contents: '' } })) }, label);
    return result?.ids ?? null;
  }

  onPointerDown(e) {
    if (!this.active || this.tool !== 'area' || e.button !== 0) return;
    if (e.target.closest('.annot-toolbar, .side-panel, .find-bar, dialog, .annot-selection')) return;
    if (e.target.closest('.annot-box[data-subtype="Redact"]')) return; // selecting a mark
    const pageEl = e.target.closest('.page');
    const tab = this.tab;
    if (!pageEl || !tab?.host.contains(pageEl)) return;
    const view = tab.viewer.views[Number(pageEl.dataset.pageNumber) - 1];
    if (!view?.baseViewport) return;
    e.preventDefault();
    this.app.annotator?.deselect();
    const g = pageGeometry(tab.viewer, view);
    const [x, y] = g.local(e.clientX, e.clientY);
    const draft = h('div.redact-draft', { 'aria-hidden': 'true' });
    view.el.append(draft);
    let end = [x, y];
    const place = () => {
      const [x0, y0, x1, y1] = norm([x, y, end[0], end[1]]);
      Object.assign(draft.style, { left: `${x0}px`, top: `${y0}px`, width: `${x1 - x0}px`, height: `${y1 - y0}px` });
    };
    place();
    const move = (ev) => {
      end = g.local(ev.clientX, ev.clientY);
      place();
    };
    const up = async () => {
      this.cancelDraft = null;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      draft.remove();
      const box = norm([x, y, end[0], end[1]]);
      if (box[2] - box[0] < 3 || box[3] - box[1] < 3) return;
      const ids = await this.mark([{ page: view.index, rect: g.cssToPdfRect(box) }], t('step.markRedaction'));
      if (ids?.[0]) this.app.annotator.select(view.index, ids[0]);
    };
    this.cancelDraft = () => up();
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  async markSelection() {
    const tab = this.tab;
    if (!tab) return;
    const picked = selectionQuads(tab, tab.viewer);
    if (!picked) return;
    await this.mark(picked.pages, t('step.markRedaction'));
  }

  async markAll(query, options) {
    const tab = this.tab;
    const re = buildQuery(query, options);
    if (!tab || !re) return 0;
    this.toolbar.setBusy(true);
    try {
      const pages = await findMatchQuads(tab.pdf, re);
      const n = pages.reduce((sum, p) => sum + p.quads.length, 0);
      if (!n) {
        toast(t('redact.noMatches', { query }));
        return 0;
      }
      // One mark per match, so each can be reviewed and removed on its own.
      await this.mark(pages.flatMap(({ page, quads }) => quads.map((q) => ({ page, quads: [q] }))), tn('step.markMatches', n));
      toast(t('redact.marked', { matches: tn('redact.matches', n), pages: tn('redact.pages', pages.length) }));
      return n;
    } finally {
      this.toolbar.setBusy(false);
    }
  }

  async removeAll() {
    const tab = this.tab;
    if (!tab || !this.marks.length) return;
    this.app.annotator?.deselect();
    await this.app.edit(tab, 'removeRedactions', {}, t('step.removeRedactions'));
  }

  /** Burn the marks in (after a warning). One undo step. */
  async apply() {
    const tab = this.app.editableTab();
    if (!tab) return;
    const marks = await tab.model.query('listRedactions', {}).catch(() => []);
    if (!marks.length) {
      toast(t('redact.none'));
      return;
    }
    const byPage = new Map();
    for (const m of marks) byPage.set(m.page, [...(byPage.get(m.page) ?? []), ...m.rects]);
    const pages = [...byPage.keys()].sort((a, b) => a - b);
    const ok = await confirmDialog({
      title: t('redact.applyTitle'),
      message: t('redact.applyMessage', { marks: tn('redact.areas', marks.length), pagesWord: tn('redact.pages', pages.length), list: pages.map((p) => tab.viewer.pageLabel(p)).join(', '), dpi: REDACT_DPI }),
      confirmLabel: t('redact.applyConfirm'),
      danger: true,
    });
    if (!ok) return;
    this.app.annotator?.deselect();
    const status = h('p.redact-progress', { role: 'status' });
    const bar = h('progress', { max: pages.length, value: 0 });
    let cancelled = false;
    const modal = createModal({
      title: t('redact.applying'),
      body: [status, bar],
      footer: [h('button.btn', { type: 'button', onclick: () => { cancelled = true; } }, t('common.cancel'))],
      onCancel: () => { cancelled = true; },
    });
    try {
      const pdfjs = tab.viewer.pdfjs;
      const jobs = [];
      for (const [k, page] of pages.entries()) {
        if (cancelled) return;
        status.textContent = t('redact.progress', { n: k + 1, total: pages.length });
        bar.value = k;
        const rects = byPage.get(page);
        const { jpg, view } = await renderRedactedPage(pdfjs, tab.pdf, page, rects);
        jobs.push({ page, jpg, view, rects });
      }
      if (cancelled) return;
      status.textContent = t('redact.saving');
      bar.value = pages.length;
      modal.setBusy(true);
      const done = await this.app.edit(tab, 'applyRedactions', { pages: jobs }, tn('step.applyRedactions', marks.length));
      if (done) toast(t('redact.applied', { areas: tn('redact.areas', marks.length), pages: tn('redact.pages', pages.length) }));
    } finally {
      modal.close();
    }
  }

  // ------------------------------------------------------------ toolbar

  buildToolbar() {
    const toolBtn = (tool, iconName) => h('button.btn.icon-btn.annot-tool', {
      type: 'button', 'aria-pressed': 'false', 'aria-label': t(`redact.tool.${tool}`), title: t(`redact.tool.${tool}`), dataset: { tool },
      onclick: () => this.activate(tool),
    }, icon(iconName));
    const area = toolBtn('area', 'redact');
    const text = toolBtn('text', 'textCursor');
    const query = h('input.input.redact-query', { type: 'search', 'aria-label': t('redact.query'), placeholder: t('redact.query'), autocomplete: 'off' });
    const matchCase = h('button.btn.find-toggle', { type: 'button', 'aria-pressed': 'false', 'aria-label': t('find.matchCase'), title: t('find.matchCase'), onclick: () => matchCase.setAttribute('aria-pressed', String(matchCase.getAttribute('aria-pressed') !== 'true')) }, 'Aa');
    const wholeWord = h('button.btn.find-toggle', { type: 'button', 'aria-pressed': 'false', 'aria-label': t('find.wholeWord'), title: t('find.wholeWord'), onclick: () => wholeWord.setAttribute('aria-pressed', String(wholeWord.getAttribute('aria-pressed') !== 'true')) }, h('span.find-word-icon', 'ab'));
    const markAll = h('button.btn.btn-sm', { type: 'button', onclick: () => run() }, t('redact.markAll'));
    const run = () => this.markAll(query.value, { matchCase: matchCase.getAttribute('aria-pressed') === 'true', wholeWord: wholeWord.getAttribute('aria-pressed') === 'true' });
    query.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        run();
      }
    });
    const count = h('span.redact-count', { role: 'status', 'aria-live': 'polite' });
    const remove = h('button.btn.btn-sm', { type: 'button', onclick: () => this.removeAll() }, t('redact.removeAll'));
    const apply = h('button.btn.btn-sm.danger', { type: 'button', onclick: () => this.apply() }, t('redact.apply'));
    const done = h('button.btn.annot-done', { type: 'button', title: `${t('annot.done')} (Esc)`, onclick: () => this.deactivate() }, t('annot.done'));
    const el = h('div.annot-toolbar.redact-toolbar', { role: 'toolbar', 'aria-label': t('redact.toolbar'), hidden: true },
      h('div.annot-group', { role: 'group' }, area, text),
      h('span.annot-sep', { 'aria-hidden': 'true' }),
      h('div.annot-group.redact-search', { role: 'search' }, query, matchCase, wholeWord, markAll),
      h('span.annot-sep', { 'aria-hidden': 'true' }),
      count,
      h('div.annot-actions', remove, apply, done));
    const main = this.app.shell.main;
    new ResizeObserver(() => {
      if (!el.hidden) main.style.setProperty('--annot-bar-h', `${el.offsetHeight}px`);
    }).observe(el);
    return {
      el,
      show: () => {
        el.hidden = false;
        main.classList.add('annot-on');
      },
      hide: () => {
        el.hidden = true;
        if (!this.app.annotator?.tool && !this.app.formEditor?.tool) main.classList.remove('annot-on');
      },
      setBusy: (b) => {
        markAll.disabled = b;
        el.dataset.busy = String(b);
      },
      sync: () => {
        area.setAttribute('aria-pressed', String(this.tool === 'area'));
        text.setAttribute('aria-pressed', String(this.tool === 'text'));
        const pages = new Set(this.marks.map((m) => m.page)).size;
        count.textContent = this.marks.length ? t('redact.count', { marks: tn('redact.marks', this.marks.length), pages: tn('redact.pages', pages) }) : t('redact.countNone');
        remove.disabled = !this.marks.length;
        apply.disabled = !this.marks.length;
      },
    };
  }
}
