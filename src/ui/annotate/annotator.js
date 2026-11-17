// Commenting: annotation tools, selection, move/resize/delete, drawing.
//
// Every change is a worker op through app.edit() → one named undo step, and
// writes a real PDF annotation with an appearance stream (core/ops/annot-*).
// The page's annotation layer (view/page-view.js) provides hit areas; this
// controller adds the selection frame, drafts and the inline text editor.
import { h } from '../dom.js';
import { t, hasString } from '../../i18n/index.js';
import { toast } from '../toast.js';
import { getPref, setPref } from '../../core/prefs.js';
import { authorName } from '../../core/settings.js';
import { createAnnotateToolbar } from './toolbar.js';

export const TOOLS = ['select', 'highlight', 'underline', 'strikeout', 'note', 'freetext', 'square', 'circle', 'line', 'arrow', 'ink'];
export const MARKUP_TOOLS = new Set(['highlight', 'underline', 'strikeout']);
const DRAW_TOOLS = new Set(['note', 'freetext', 'square', 'circle', 'line', 'arrow', 'ink']);

export const DEFAULT_STYLES = {
  highlight: { color: '#ffd400', opacity: 0.45 },
  underline: { color: '#0050c8', opacity: 1 },
  strikeout: { color: '#b70228', opacity: 1 },
  note: { color: '#ffd400', opacity: 1 },
  freetext: { color: '#1e2327', opacity: 1, fontSize: 14 },
  square: { color: '#b70228', opacity: 1, width: 2 },
  circle: { color: '#0050c8', opacity: 1, width: 2 },
  line: { color: '#b70228', opacity: 1, width: 2 },
  arrow: { color: '#b70228', opacity: 1, width: 2 },
  ink: { color: '#b70228', opacity: 1, width: 3 },
};

/** Subtypes that can be moved / resized. */
const MOVABLE = new Set(['Square', 'Circle', 'Line', 'Ink', 'FreeText', 'Text', 'Stamp', 'Polygon', 'PolyLine', 'Caret', 'FileAttachment']);
const FIXED_SIZE = new Set(['Text', 'FileAttachment', 'Caret']);
const SUBTYPE_OF_TOOL = { highlight: 'Highlight', underline: 'Underline', strikeout: 'StrikeOut', note: 'Text', freetext: 'FreeText', square: 'Square', circle: 'Circle', line: 'Line', ink: 'Ink' };
const SUBTYPE_TOOL = { Highlight: 'highlight', Underline: 'underline', StrikeOut: 'strikeout', Text: 'note', FreeText: 'freetext', Square: 'square', Circle: 'circle', Line: 'line', Ink: 'ink' };

const norm = (r) => [Math.min(r[0], r[2]), Math.min(r[1], r[3]), Math.max(r[0], r[2]), Math.max(r[1], r[3])];

/** Pointer/CSS ↔ PDF conversions for a page view (CSS px relative to the page box). */
export function pageGeometry(viewer, view) {
  const viewport = view.baseViewport.clone({ scale: viewer.layout.scale });
  const rect = view.el.getBoundingClientRect();
  return {
    view,
    page: view.index,
    viewport,
    local: (clientX, clientY) => [clientX - rect.left, clientY - rect.top],
    toPdf: (x, y) => viewport.convertToPdfPoint(x, y),
    toCss: (pdfRect) => toViewportRect(viewport, pdfRect),
    cssToPdfRect: (box) => {
      const a = viewport.convertToPdfPoint(box[0], box[1]);
      const b = viewport.convertToPdfPoint(box[2], box[3]);
      return norm([a[0], a[1], b[0], b[1]]);
    },
  };
}

/** Our visual signatures are Stamp annotations with this /Contents. */
export const SIGNATURE_CONTENTS = 'Visual signature';
export const isSignature = (a) => a?.subtype === 'Stamp' && a.contentsObj?.str === SIGNATURE_CONTENTS;

/** A PDF rect → viewport rect (pdf.js 6 dropped convertToViewportRectangle). */
export function toViewportRect(viewport, r) {
  const a = viewport.convertToViewportPoint(r[0], r[1]);
  const b = viewport.convertToViewportPoint(r[2], r[3]);
  return norm([a[0], a[1], b[0], b[1]]);
}

export class Annotator extends EventTarget {
  constructor(app) {
    super();
    this.app = app;
    this.tool = null; // null = not in annotation mode
    this.selection = null; // { tabId, page, id }
    this.pendingEdit = null; // comment id the Comments panel should open for editing
    this.toolbar = createAnnotateToolbar(this);
    app.shell.main.append(this.toolbar.el);
    this.bind();
  }

  get tab() {
    return this.app.activeTab;
  }

  get viewer() {
    return this.tab?.viewer ?? null;
  }

  // -------------------------------------------------------- tools & styles

  style(tool = this.tool) {
    const key = tool === 'select' || !tool ? null : tool;
    if (!key) return null;
    return { ...DEFAULT_STYLES[key], ...getPref(`annot.style.${key}`, {}) };
  }

  /** The tool whose remembered style the toolbar edits: the selection's type, else the active tool. */
  styleTool() {
    const sel = this.selected();
    if (sel) {
      const own = Annotator.toolFor(sel.data.subtype);
      // A just-drawn arrow is a Line; keep saving to the active arrow tool.
      const toolSubtype = { arrow: 'Line' }[this.tool] ?? SUBTYPE_OF_TOOL[this.tool];
      return toolSubtype === sel.data.subtype ? this.tool : own;
    }
    return this.tool && this.tool !== 'select' ? this.tool : null;
  }

  /** Style shown in the toolbar: the selection's own, or the tool's last-used. */
  currentStyle() {
    const sel = this.selected();
    const tool = this.styleTool();
    if (!tool) return null;
    const base = this.style(tool);
    if (!sel) return base;
    const d = sel.data;
    const c = d.subtype === 'FreeText' ? d.defaultAppearanceData?.fontColor ?? d.color : d.color;
    const hex = c && c.length >= 3 ? `#${[...c].slice(0, 3).map((v) => v.toString(16).padStart(2, '0')).join('')}` : base.color;
    return {
      color: hex,
      opacity: typeof d.opacity === 'number' ? d.opacity : base.opacity,
      width: d.borderStyle?.width || base.width,
      fontSize: d.defaultAppearanceData?.fontSize || base.fontSize,
    };
  }

  /** Change style: remembered for the tool, and applied to the selection (one undo step). */
  setStyle(patch) {
    const tool = this.styleTool();
    if (tool) setPref(`annot.style.${tool}`, { ...getPref(`annot.style.${tool}`, {}), ...patch });
    const sel = this.selected();
    if (sel && !sel.tab.model.readOnly && Object.keys(patch).length) {
      const { tab, page, data } = sel;
      this.app.edit(tab, 'updateAnnotation', { page, id: data.id, ...patch }, t('step.styleAnnot', { type: this.typeName(data.subtype, data) }));
    }
    this.toolbar.sync();
  }

  /** Enter annotation mode with a tool (or switch tools). */
  activate(tool = 'select') {
    const tab = this.tab;
    if (!tab) {
      toast(t('annot.needsDocument'));
      return;
    }
    if (tool !== 'select' && tab.model.readOnly) {
      toast(t(`edit.readOnly.${tab.model.readOnly}`), { kind: 'error' });
      return;
    }
    this.app.closeOrganizer?.();
    this.app.formEditor?.deactivate();
    this.app.forms?.cancelPlacing();
    this.cancelDraft();
    this.tool = tool;
    if (DRAW_TOOLS.has(tool)) this.deselect();
    this.syncHostClasses();
    this.toolbar.show();
    this.toolbar.sync();
    if (MARKUP_TOOLS.has(tool)) this.applyMarkupFromSelection();
    this.dispatchEvent(new CustomEvent('toolchange'));
  }

  deactivate() {
    this.cancelDraft();
    this.tool = null;
    this.syncHostClasses();
    this.toolbar.hide();
    this.dispatchEvent(new CustomEvent('toolchange'));
  }

  syncHostClasses() {
    for (const tab of this.app.tabs) {
      const active = tab === this.tab && this.tool;
      tab.host.classList.toggle('annotating', !!active && DRAW_TOOLS.has(this.tool));
      tab.host.classList.toggle('annot-select', !!active && this.tool === 'select');
      tab.host.classList.toggle('annot-markup', !!active && MARKUP_TOOLS.has(this.tool));
      tab.host.dataset.annotTool = active ? this.tool : '';
    }
  }

  typeName(subtype, data) {
    if (data && isSignature(data)) return t('annot.type.Signature');
    return hasString(`annot.type.${subtype}`) ? t(`annot.type.${subtype}`) : subtype || t('annot.type.unknown');
  }

  // --------------------------------------------------------------- input

  bind() {
    const main = this.app.shell.main;
    main.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    main.addEventListener('dblclick', (e) => {
      const box = e.target.closest?.('.annot-box');
      if (box) this.editComment(box.dataset.annotId);
    });
    document.addEventListener('mouseup', () => {
      if (MARKUP_TOOLS.has(this.tool)) setTimeout(() => this.applyMarkupFromSelection(), 0);
    });
    this.app.addEventListener('organizerchange', () => {
      if (this.app.organizerOpen) this.deactivate();
    });
    this.app.addEventListener('tabchange', () => {
      this.deselect();
      if (!this.tab) this.deactivate();
      else this.syncHostClasses();
      this.toolbar.sync();
    });
    // Keep the selection frame in place when pages re-render or zoom.
    const reframe = () => requestAnimationFrame(() => {
      this.renderSelection();
      if (this.tool) this.toolbar.sync();
    });
    this.app.addEventListener('documentopened', (e) => {
      const viewer = e.detail.tab.viewer;
      for (const type of ['annotations', 'zoomchange', 'layoutchange', 'docchange']) viewer.addEventListener(type, reframe);
    });
  }

  /** Esc: cancel a draft, else deselect, else leave annotation mode. */
  get canEscape() {
    return !!(this.draft || this.selected() || this.tool);
  }

  escape() {
    if (this.draft) this.cancelDraft();
    else if (this.selected()) this.deselect();
    else this.deactivate();
  }

  /** Page view + geometry helpers for a .page element of the active tab. */
  pageAt(target) {
    const pageEl = target.closest?.('.page');
    const tab = this.tab;
    if (!pageEl || !tab || !tab.host.contains(pageEl) || tab.organizer?.isOpen) return null;
    const view = tab.viewer.views[Number(pageEl.dataset.pageNumber) - 1];
    if (!view?.baseViewport) return null;
    return this.geometry(view);
  }

  geometry(view) {
    return pageGeometry(this.viewer, view);
  }

  onPointerDown(e) {
    if (e.button !== 0) return;
    const handle = e.target.closest?.('.annot-handle');
    const box = e.target.closest?.('.annot-box');
    const frame = e.target.closest?.('.annot-selection');
    if (handle || frame) {
      this.startTransform(e, handle?.dataset.handle ?? 'move');
      return;
    }
    if (DRAW_TOOLS.has(this.tool)) {
      const g = this.pageAt(e.target);
      if (g) this.startDraw(e, g);
      return;
    }
    if (box) {
      const g = this.pageAt(box);
      if (!g) return;
      const data = g.view.annotations?.find((a) => a.id === box.dataset.annotId);
      if (!data) return;
      if (!this.tool) this.activate('select');
      this.select(g.page, data.id);
      if (MOVABLE.has(data.subtype) && !this.tab.model.readOnly) this.startTransform(e, 'move');
      return;
    }
    if (this.selection && !e.target.closest('.annot-toolbar, .side-panel, .find-bar')) this.deselect();
  }

  // ----------------------------------------------------------- selection

  select(page, id) {
    this.selection = { tabId: this.tab.id, page, id };
    this.renderSelection();
    this.toolbar.sync();
    this.dispatchEvent(new CustomEvent('selectionchange', { detail: { page, id } }));
  }

  deselect() {
    if (!this.selection) return;
    this.selection = null;
    this.renderSelection();
    this.toolbar.sync();
    this.dispatchEvent(new CustomEvent('selectionchange', { detail: null }));
  }

  /** { tab, page, data, view } for the current selection, if it's still there. */
  selected() {
    const s = this.selection;
    const tab = this.tab;
    if (!s || !tab || tab.id !== s.tabId) return null;
    const view = tab.viewer.views[s.page];
    const data = view?.annotations?.find((a) => a.id === s.id);
    return data ? { tab, page: s.page, data, view } : null;
  }

  renderSelection() {
    for (const el of document.querySelectorAll('.annot-selection')) el.remove();
    const sel = this.selected();
    if (!sel) return;
    const g = this.geometry(sel.view);
    const [x0, y0, x1, y1] = g.toCss(sel.data.rect);
    const movable = MOVABLE.has(sel.data.subtype) && !sel.tab.model.readOnly;
    const resizable = movable && !FIXED_SIZE.has(sel.data.subtype);
    const frame = h(`div.annot-selection${movable ? '.movable' : ''}`, {
      dataset: { annotId: sel.data.id },
      'aria-hidden': 'true',
    }, resizable ? ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'].map((p) => h(`span.annot-handle.h-${p}`, { dataset: { handle: p } })) : null);
    Object.assign(frame.style, { left: `${x0 - 3}px`, top: `${y0 - 3}px`, width: `${x1 - x0 + 6}px`, height: `${y1 - y0 + 6}px` });
    sel.view.el.append(frame);
  }

  startTransform(e, mode) {
    const sel = this.selected();
    if (!sel || sel.tab.model.readOnly || !MOVABLE.has(sel.data.subtype)) return;
    e.preventDefault();
    const g = this.geometry(sel.view);
    const start = g.toCss(sel.data.rect);
    const [sx, sy] = g.local(e.clientX, e.clientY);
    const frame = sel.view.el.querySelector('.annot-selection');
    let box = start;
    let moved = false;
    const move = (ev) => {
      const [x, y] = g.local(ev.clientX, ev.clientY);
      const dx = x - sx;
      const dy = y - sy;
      if (!moved && Math.hypot(dx, dy) < 3) return;
      moved = true;
      let [x0, y0, x1, y1] = start;
      if (mode === 'move') {
        x0 += dx; x1 += dx; y0 += dy; y1 += dy;
      } else {
        if (mode.includes('w')) x0 = Math.min(x1 - 8, x0 + dx);
        if (mode.includes('e')) x1 = Math.max(x0 + 8, x1 + dx);
        if (mode.includes('n')) y0 = Math.min(y1 - 8, y0 + dy);
        if (mode.includes('s')) y1 = Math.max(y0 + 8, y1 + dy);
        // Signatures and stamps keep their aspect ratio.
        if (sel.data.subtype === 'Stamp') {
          const ratio = (start[2] - start[0]) / Math.max(1, start[3] - start[1]);
          const w = x1 - x0;
          const hh = y1 - y0;
          if (mode === 'n' || mode === 's') {
            x1 = x0 + hh * ratio;
          } else if (mode === 'e' || mode === 'w') {
            y1 = y0 + w / ratio;
          } else {
            const k = Math.max(w / (start[2] - start[0]), hh / (start[3] - start[1]));
            const nw = (start[2] - start[0]) * k;
            const nh = (start[3] - start[1]) * k;
            if (mode.includes('w')) x0 = x1 - nw; else x1 = x0 + nw;
            if (mode.includes('n')) y0 = y1 - nh; else y1 = y0 + nh;
          }
        }
      }
      box = [x0, y0, x1, y1];
      frame?.classList.add('dragging');
      Object.assign(frame?.style ?? {}, { left: `${x0 - 3}px`, top: `${y0 - 3}px`, width: `${x1 - x0 + 6}px`, height: `${y1 - y0 + 6}px` });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      frame?.classList.remove('dragging');
      if (!moved) return;
      const label = t(mode === 'move' ? 'step.moveAnnot' : 'step.resizeAnnot', { type: this.typeName(sel.data.subtype, sel.data) });
      this.app.edit(sel.tab, 'updateAnnotation', { page: sel.page, id: sel.data.id, from: sel.data.rect, rect: g.cssToPdfRect(box) }, label);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  async deleteSelected() {
    const sel = this.selected();
    if (!sel) return;
    if (sel.tab.model.readOnly) {
      toast(t(`edit.readOnly.${sel.tab.model.readOnly}`), { kind: 'error' });
      return;
    }
    const label = t('step.deleteAnnot', { type: this.typeName(sel.data.subtype, sel.data) });
    this.deselect();
    await this.app.edit(sel.tab, 'deleteAnnotations', { page: sel.page, ids: [sel.data.id] }, label);
  }

  editComment(id) {
    this.pendingEdit = id;
    this.app.showPanel('comments');
    this.dispatchEvent(new CustomEvent('editcomment', { detail: { id } }));
  }

  // -------------------------------------------------------------- create

  /** Add annotations ([{ page, spec }]) as one step, then select the first. */
  async create(items, label) {
    const tab = this.tab;
    const author = authorName() || t('comments.anonymous');
    const result = await this.app.edit(tab, 'addAnnotations', { items: items.map((it) => ({ ...it, spec: { ...it.spec, author } })) }, label);
    const id = result?.ids?.[0];
    if (id) this.select(items[0].page, id);
    return id ?? null;
  }

  startDraw(e, g) {
    const tool = this.tool;
    this.deselect();
    const style = this.style(tool);
    e.preventDefault();
    const [x, y] = g.local(e.clientX, e.clientY);
    if (tool === 'note') {
      const [px, py] = g.toPdf(x, y);
      this.create([{ page: g.page, spec: { type: 'note', rect: [px, py - 20], color: style.color, opacity: style.opacity, contents: '' } }], t('step.addAnnot', { type: this.typeName('Text') }))
        .then((id) => id && this.editComment(id));
      return;
    }
    if (tool === 'freetext') {
      this.startTextBox(g, x, y, style);
      return;
    }
    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('class', 'annot-draft');
    const shape = document.createElementNS(svgNS, tool === 'square' ? 'rect' : tool === 'circle' ? 'ellipse' : tool === 'ink' ? 'polyline' : 'line');
    shape.setAttribute('stroke', style.color);
    shape.setAttribute('stroke-width', String((style.width ?? 1) * this.viewer.layout.scale));
    shape.setAttribute('stroke-opacity', String(style.opacity ?? 1));
    shape.setAttribute('fill', 'none');
    shape.setAttribute('stroke-linecap', 'round');
    shape.setAttribute('stroke-linejoin', 'round');
    svg.append(shape);
    g.view.el.append(svg);
    const points = [[x, y]];
    let end = [x, y];
    this.draft = { cancel: () => svg.remove() };
    const draw = () => {
      const [x0, y0] = points[0];
      const [x1, y1] = end;
      if (tool === 'square') {
        shape.setAttribute('x', Math.min(x0, x1)); shape.setAttribute('y', Math.min(y0, y1));
        shape.setAttribute('width', Math.abs(x1 - x0)); shape.setAttribute('height', Math.abs(y1 - y0));
      } else if (tool === 'circle') {
        shape.setAttribute('cx', (x0 + x1) / 2); shape.setAttribute('cy', (y0 + y1) / 2);
        shape.setAttribute('rx', Math.abs(x1 - x0) / 2); shape.setAttribute('ry', Math.abs(y1 - y0) / 2);
      } else if (tool === 'ink') {
        shape.setAttribute('points', points.map((p) => p.join(',')).join(' '));
      } else {
        shape.setAttribute('x1', x0); shape.setAttribute('y1', y0); shape.setAttribute('x2', x1); shape.setAttribute('y2', y1);
      }
    };
    const move = (ev) => {
      end = g.local(ev.clientX, ev.clientY);
      if (tool === 'ink') {
        const last = points.at(-1);
        if (Math.hypot(end[0] - last[0], end[1] - last[1]) >= 2) points.push(end);
      }
      draw();
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (!this.draft) return;
      this.draft = null;
      const [x0, y0] = points[0];
      const big = Math.hypot(end[0] - x0, end[1] - y0) >= 4 || (tool === 'ink' && points.length > 2);
      if (!big) {
        svg.remove();
        return;
      }
      const base = { color: style.color, opacity: style.opacity, width: style.width };
      let spec;
      if (tool === 'square' || tool === 'circle') spec = { ...base, type: tool, rect: g.cssToPdfRect(norm([x0, y0, end[0], end[1]])) };
      else if (tool === 'line' || tool === 'arrow') spec = { ...base, type: 'line', arrow: tool === 'arrow', line: [...g.toPdf(x0, y0), ...g.toPdf(end[0], end[1])] };
      else spec = { ...base, type: 'ink', ink: [points.flatMap(([px, py]) => g.toPdf(px, py))] };
      const subtype = { square: 'Square', circle: 'Circle', line: 'Line', arrow: 'Line', ink: 'Ink' }[tool];
      this.create([{ page: g.page, spec }], t('step.addAnnot', { type: this.typeName(subtype) })).finally(() => svg.remove());
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  startTextBox(g, x, y, style) {
    this.cancelDraft();
    const scale = this.viewer.layout.scale;
    const size = style.fontSize ?? 14;
    const area = h('textarea.annot-textbox', {
      rows: '1',
      'aria-label': t('annot.textBoxLabel'),
      placeholder: t('annot.textBoxPlaceholder'),
    });
    Object.assign(area.style, {
      left: `${x}px`,
      top: `${y}px`,
      fontSize: `${size * scale}px`,
      lineHeight: '1.2',
      padding: `${4 * scale}px`,
      color: style.color,
    });
    g.view.el.append(area);
    let done = false;
    const finish = (commit) => {
      if (done) return;
      done = true;
      this.draft = null;
      const text = area.value.replace(/\s+$/, '');
      const box = [area.offsetLeft, area.offsetTop, area.offsetLeft + area.offsetWidth, area.offsetTop + area.offsetHeight];
      area.remove();
      if (!commit || !text) return;
      const spec = { type: 'freetext', rect: g.cssToPdfRect(box), text, fontSize: size, color: style.color, opacity: style.opacity };
      this.create([{ page: g.page, spec }], t('step.addAnnot', { type: this.typeName('FreeText') }));
    };
    area.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        finish(false);
      } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        finish(true);
      }
    });
    area.addEventListener('blur', () => finish(true));
    this.draft = { cancel: () => finish(false) };
    requestAnimationFrame(() => area.focus());
  }

  cancelDraft() {
    const d = this.draft;
    this.draft = null;
    d?.cancel();
  }

  // --------------------------------------------------------- text markup

  /** Turn the current text selection into highlight/underline/strike-out quads. */
  applyMarkupFromSelection() {
    if (!MARKUP_TOOLS.has(this.tool) || !this.tab) return false;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return false;
    const range = sel.getRangeAt(0);
    if (!this.tab.host.contains(range.commonAncestorContainer)) return false;
    const byPage = new Map();
    for (const r of range.getClientRects()) {
      if (r.width < 1 || r.height < 1) continue;
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const view = this.viewer.views.find((v) => {
        if (!v.textLayer || !v.baseViewport) return false;
        const b = v.el.getBoundingClientRect();
        return cx >= b.left && cx <= b.right && cy >= b.top && cy <= b.bottom && r.height < b.height / 3;
      });
      if (!view) continue;
      if (!byPage.has(view.index)) byPage.set(view.index, []);
      byPage.get(view.index).push(r);
    }
    if (!byPage.size) return false;
    const items = [];
    for (const [page, rects] of byPage) {
      const g = this.geometry(this.viewer.views[page]);
      const quads = mergeLineRects(rects.map((r) => {
        const [x0, y0] = g.local(r.left, r.top);
        return [x0, y0, x0 + r.width, y0 + r.height];
      })).map(([x0, y0, x1, y1]) => [...g.toPdf(x0, y0), ...g.toPdf(x1, y0), ...g.toPdf(x0, y1), ...g.toPdf(x1, y1)]);
      const style = this.style();
      items.push({ page, spec: { type: this.tool, quads, color: style.color, opacity: style.opacity, contents: range.toString().slice(0, 500) } });
    }
    sel.removeAllRanges();
    const subtype = { highlight: 'Highlight', underline: 'Underline', strikeout: 'StrikeOut' }[this.tool];
    this.create(items, t('step.addAnnot', { type: this.typeName(subtype) }));
    return true;
  }

  /** The tool that matches an annotation's subtype (for the style controls). */
  static toolFor(subtype) {
    return SUBTYPE_TOOL[subtype] ?? null;
  }
}

/** Merge rects on the same line that touch or overlap (CSS px boxes). */
export function mergeLineRects(rects) {
  const sorted = [...rects].sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  const out = [];
  for (const r of sorted) {
    const last = out.at(-1);
    const sameLine = last && Math.abs(last[1] - r[1]) < 3 && Math.abs(last[3] - r[3]) < 3;
    if (sameLine && r[0] <= last[2] + 4) {
      last[0] = Math.min(last[0], r[0]);
      last[1] = Math.min(last[1], r[1]);
      last[2] = Math.max(last[2], r[2]);
      last[3] = Math.max(last[3], r[3]);
    } else {
      out.push([...r]);
    }
  }
  return out;
}
