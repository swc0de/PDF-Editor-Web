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
  freetext: { color: '#1e2327', opacity: 1, fontSize: 12, fontFamily: 'Helvetica', bold: false, italic: false, underline: false, align: 'left', fill: null, border: null, borderWidth: 1 },
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

/** Browser fonts matching the PDF standard fonts (metric-compatible where possible). */
export const FONT_CSS = {
  Helvetica: 'Helvetica, Arial, "Liberation Sans", sans-serif',
  Times: '"Times New Roman", Times, "Liberation Serif", serif',
  Courier: '"Courier New", Courier, "Liberation Mono", monospace',
};

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
    if (this.editing) return this.editing.style;
    const sel = this.selected();
    const tool = this.styleTool();
    if (!tool) return null;
    const base = this.style(tool);
    if (!sel) return base;
    const d = sel.data;
    if (d.subtype === 'FreeText') {
      const spec = this.selSpec?.id === d.id ? this.selSpec.spec : null;
      return spec ? { ...base, ...spec } : base;
    }
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
    const tool = this.editing ? 'freetext' : this.styleTool();
    if (tool) setPref(`annot.style.${tool}`, { ...getPref(`annot.style.${tool}`, {}), ...patch });
    if (this.editing) {
      // While typing: restyle the editor; it's saved with the text (one step).
      Object.assign(this.editing.style, patch);
      this.applyEditorStyle();
      this.toolbar.sync();
      this.editing.area.focus();
      return;
    }
    const sel = this.selected();
    if (sel?.data.subtype === 'FreeText' && this.selSpec?.id === sel.data.id) Object.assign(this.selSpec.spec, patch);
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
    this.app.redactor?.deactivate();
    this.cancelDraft();
    this.finishTextEditor();
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
    this.finishTextEditor();
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
      // A selected annotation's frame sits on top of it: double-click works there too.
      const frame = e.target.closest?.('.annot-selection');
      const sel = frame ? this.selected() : null;
      if (sel) {
        if (sel.data.subtype === 'FreeText') this.editTextBox(sel.page, sel.data.id);
        else this.editComment(sel.data.id);
        return;
      }
      const box = e.target.closest?.('.annot-box');
      if (!box) return;
      const g = this.pageAt(box);
      if (box.dataset.subtype === 'FreeText' && g) this.editTextBox(g.page, box.dataset.annotId);
      else this.editComment(box.dataset.annotId);
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
      viewer.addEventListener('docchange', () => {
        if (this.selection && e.detail.tab === this.tab) this.loadSelSpec();
      });
      viewer.addEventListener('zoomchange', () => this.applyEditorStyle());
    });
  }

  /** Esc: cancel a draft, else deselect, else leave annotation mode. */
  get canEscape() {
    return !!(this.editing || this.draft || this.selected() || this.tool);
  }

  escape() {
    if (this.editing) this.finishTextEditor();
    else if (this.draft) this.cancelDraft();
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
    if (e.target.closest?.('.annot-texteditor')) return;
    if (DRAW_TOOLS.has(this.tool)) {
      const g = this.pageAt(e.target);
      if (!g) return;
      if (this.tool === 'freetext') {
        // Clicking an existing text box with the text tool edits it (like Word).
        const [x, y] = g.local(e.clientX, e.clientY);
        const hit = g.view.annotations?.find((a) => {
          if (a.subtype !== 'FreeText') return false;
          const [x0, y0, x1, y1] = g.toCss(a.rect);
          return x >= x0 && x <= x1 && y >= y0 && y <= y1;
        });
        if (hit) {
          e.preventDefault();
          this.editTextBox(g.page, hit.id);
          return;
        }
      }
      this.startDraw(e, g);
      return;
    }
    if (box) {
      const g = this.pageAt(box);
      if (!g) return;
      const data = g.view.annotations?.find((a) => a.id === box.dataset.annotId);
      if (!data) return;
      if (!this.tool && !this.app.redactor?.active) this.activate('select');
      this.select(g.page, data.id);
      if (MOVABLE.has(data.subtype) && !this.tab.model.readOnly) this.startTransform(e, 'move');
      return;
    }
    if (this.selection && !e.target.closest('.annot-toolbar, .side-panel, .find-bar')) this.deselect();
  }

  // ----------------------------------------------------------- selection

  select(page, id) {
    this.selection = { tabId: this.tab.id, page, id };
    this.selSpec = null;
    this.renderSelection();
    this.toolbar.sync();
    this.loadSelSpec();
    this.dispatchEvent(new CustomEvent('selectionchange', { detail: { page, id } }));
  }

  /** Text boxes keep their full style (font, B/I/U…) in the PDF; fetch it for the toolbar. */
  async loadSelSpec() {
    const sel = this.selection;
    const tab = this.tab;
    if (!sel || !tab || tab.id !== sel.tabId) return;
    const spec = await tab.model.query('annotationSpec', { page: sel.page, id: sel.id }).catch(() => null);
    if (this.selection !== sel) return;
    if (spec?.type === 'freetext') {
      const { type, rect, text, ...style } = spec;
      this.selSpec = { id: sel.id, spec: style };
    } else {
      this.selSpec = null;
    }
    if (this.tool) this.toolbar.sync();
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
    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('class', 'annot-draft');
    const boxTool = tool === 'square' || tool === 'freetext';
    const shape = document.createElementNS(svgNS, boxTool ? 'rect' : tool === 'circle' ? 'ellipse' : tool === 'ink' ? 'polyline' : 'line');
    if (tool === 'freetext') {
      // A text box is drawn like a rectangle (dashed), then typed into.
      shape.setAttribute('stroke-dasharray', '4 3');
      style.width = 1 / this.viewer.layout.scale;
      style.color = '#b70228';
    }
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
      if (boxTool) {
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
      if (tool === 'freetext') {
        svg.remove();
        // A click (no drag) gets a 200 pt wide, one-line box.
        const s = this.viewer.layout.scale;
        const st = this.style('freetext');
        let box = norm([x0, y0, end[0], end[1]]);
        if (box[2] - box[0] < 12) box = [x0, y0, x0 + 200 * s, Math.max(box[3], y0 + (st.fontSize * 1.2 + 8) * s)];
        if (box[3] - box[1] < (st.fontSize * 1.2 + 8) * s) box[3] = box[1] + (st.fontSize * 1.2 + 8) * s;
        this.openTextEditor({ g, box, text: '', style: st, existing: null });
        return;
      }
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

  // ---------------------------------------------------- text box editor

  /** Edit an existing text box in place (double-click, Enter, or the text tool). */
  async editTextBox(page, id) {
    const tab = this.tab;
    if (!tab) return;
    if (tab.model.readOnly) {
      toast(t(`edit.readOnly.${tab.model.readOnly}`), { kind: 'error' });
      return;
    }
    this.finishTextEditor();
    const spec = await tab.model.query('annotationSpec', { page, id }).catch(() => null);
    if (!spec || spec.type !== 'freetext' || this.tab !== tab) return;
    if (!this.tool) this.activate('select');
    const view = tab.viewer.views[page];
    if (!view?.baseViewport) return;
    const g = this.geometry(view);
    const { type, rect, text, ...style } = spec;
    this.openTextEditor({ g, box: g.toCss(rect), text: text ?? '', style: { ...this.style('freetext'), ...style }, existing: { page, id, rect } });
  }

  /** The on-page text editor: a box you type into, formatted from the toolbar (Word-like). */
  openTextEditor({ g, box, text, style, existing }) {
    this.finishTextEditor();
    this.deselect();
    const area = h('textarea.annot-textbox', {
      'aria-label': t('annot.textBoxLabel'),
      placeholder: t('annot.textBoxPlaceholder'),
      spellcheck: true,
    });
    area.value = text;
    const wrap = h('div.annot-texteditor', area);
    Object.assign(wrap.style, { left: `${box[0]}px`, top: `${box[1]}px`, width: `${box[2] - box[0]}px` });
    g.view.el.append(wrap);
    const editing = {
      g, wrap, area, existing,
      page: g.page,
      minHeight: box[3] - box[1],
      style: { ...style },
      start: { text, style: JSON.stringify(style) },
    };
    this.editing = editing;
    this.applyEditorStyle();
    const fit = () => {
      area.style.height = 'auto';
      area.style.height = `${Math.max(editing.minHeight, area.scrollHeight)}px`;
    };
    editing.fit = fit;
    area.addEventListener('input', fit);
    area.addEventListener('keydown', (e) => {
      const mod = e.ctrlKey || e.metaKey;
      if (e.key === 'Escape' || (e.key === 'Enter' && mod)) {
        e.preventDefault();
        e.stopPropagation();
        this.finishTextEditor();
        return;
      }
      const toggle = mod && !e.shiftKey && !e.altKey ? { b: 'bold', i: 'italic', u: 'underline' }[e.key.toLowerCase()] : null;
      if (toggle) {
        e.preventDefault();
        e.stopPropagation();
        this.setStyle({ [toggle]: !editing.style[toggle] });
      }
    });
    // Finish when the user clicks anywhere outside the box and the toolbar.
    const outside = (e) => {
      if (e.target.closest?.('.annot-texteditor, .annot-toolbar')) return;
      this.finishTextEditor();
    };
    const focusOut = () => setTimeout(() => {
      const a = document.activeElement;
      if (this.editing === editing && !a?.closest?.('.annot-texteditor, .annot-toolbar') && !document.querySelector('dialog[open]')) this.finishTextEditor();
    }, 0);
    document.addEventListener('pointerdown', outside, true);
    area.addEventListener('focusout', focusOut);
    editing.cleanup = () => document.removeEventListener('pointerdown', outside, true);
    this.toolbar.show();
    this.toolbar.sync();
    requestAnimationFrame(() => {
      fit();
      area.focus();
      area.setSelectionRange(area.value.length, area.value.length);
    });
  }

  /** Apply the editor's style (font, size, B/I/U, alignment, colours) as CSS. */
  applyEditorStyle() {
    const ed = this.editing;
    if (!ed) return;
    const st = ed.style;
    const s = this.viewer.layout.scale;
    const bw = st.border ? Math.max(0.5, Number(st.borderWidth) || 1) : 0;
    Object.assign(ed.area.style, {
      fontFamily: FONT_CSS[st.fontFamily] ?? FONT_CSS.Helvetica,
      fontSize: `${st.fontSize * s}px`,
      fontWeight: st.bold ? '700' : '400',
      fontStyle: st.italic ? 'italic' : 'normal',
      textDecoration: st.underline ? 'underline' : 'none',
      textAlign: st.align || 'left',
      color: st.color,
      padding: `${4 * s}px`,
      lineHeight: '1.2',
      // Editing an existing box hides its saved look underneath.
      background: st.fill || (ed.existing ? '#fff' : 'transparent'),
      borderWidth: `${bw * s}px`,
      borderStyle: bw ? 'solid' : 'none',
      borderColor: st.border || 'transparent',
    });
    ed.fit?.();
  }

  /** Save (or drop) what's in the text editor: one undo step. */
  async finishTextEditor() {
    const ed = this.editing;
    if (!ed) return;
    this.editing = null;
    ed.cleanup();
    const text = ed.area.value.replace(/\s+$/, '');
    const { wrap, area, g } = ed;
    const box = [wrap.offsetLeft, wrap.offsetTop, wrap.offsetLeft + area.offsetWidth, wrap.offsetTop + area.offsetHeight];
    wrap.remove();
    this.toolbar.sync();
    const tab = this.tab;
    if (!tab) return;
    const st = ed.style;
    const style = {
      fontSize: st.fontSize, fontFamily: st.fontFamily, bold: !!st.bold, italic: !!st.italic, underline: !!st.underline,
      align: st.align, fill: st.fill || null, border: st.border || null, borderWidth: st.borderWidth ?? 1, color: st.color, opacity: st.opacity ?? 1,
    };
    const rect = g.cssToPdfRect(box);
    const name = this.typeName('FreeText');
    if (!ed.existing) {
      // Like Word: after inserting a text box you're back to selecting (right
      // away, so the click that finished this box doesn't start another).
      if (this.tool === 'freetext') {
        this.tool = 'select';
        this.syncHostClasses();
        this.toolbar.sync();
        this.dispatchEvent(new CustomEvent('toolchange'));
      }
      if (!text) return;
      await this.create([{ page: ed.page, spec: { type: 'freetext', rect, text, contents: text, ...style } }], t('step.addAnnot', { type: name }));
      return;
    }
    const { page, id } = ed.existing;
    if (!text) {
      await this.app.edit(tab, 'deleteAnnotations', { page, ids: [id] }, t('step.deleteAnnot', { type: name }));
      return;
    }
    if (text === ed.start.text && JSON.stringify(st) === ed.start.style) {
      this.select(page, id);
      return;
    }
    await this.app.edit(tab, 'updateAnnotation', { page, id, from: ed.existing.rect, rect, contents: text, ...style }, t('step.editTextBox'));
    this.select(page, id);
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
    const picked = selectionQuads(this.tab, this.viewer);
    if (!picked) return false;
    const style = this.style();
    const items = picked.pages.map(({ page, quads }) => ({ page, spec: { type: this.tool, quads, color: style.color, opacity: style.opacity, contents: picked.text.slice(0, 500) } }));
    const subtype = { highlight: 'Highlight', underline: 'Underline', strikeout: 'StrikeOut' }[this.tool];
    this.create(items, t('step.addAnnot', { type: this.typeName(subtype) }));
    return true;
  }

  /** The tool that matches an annotation's subtype (for the style controls). */
  static toolFor(subtype) {
    return SUBTYPE_TOOL[subtype] ?? null;
  }
}

/**
 * The current text selection inside a tab's viewer as QuadPoints per page
 * (PDF space), then cleared: { text, pages: [{ page, quads }] } or null.
 */
export function selectionQuads(tab, viewer) {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
  const range = sel.getRangeAt(0);
  if (!tab.host.contains(range.commonAncestorContainer)) return null;
  const byPage = new Map();
  for (const r of range.getClientRects()) {
    if (r.width < 1 || r.height < 1) continue;
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const view = viewer.views.find((v) => {
      if (!v.textLayer || !v.baseViewport) return false;
      const b = v.el.getBoundingClientRect();
      return cx >= b.left && cx <= b.right && cy >= b.top && cy <= b.bottom && r.height < b.height / 3;
    });
    if (!view) continue;
    if (!byPage.has(view.index)) byPage.set(view.index, []);
    byPage.get(view.index).push(r);
  }
  if (!byPage.size) return null;
  const pages = [];
  for (const [page, rects] of byPage) {
    const g = pageGeometry(viewer, viewer.views[page]);
    const quads = mergeLineRects(rects.map((r) => {
      const [x0, y0] = g.local(r.left, r.top);
      return [x0, y0, x0 + r.width, y0 + r.height];
    })).map(([x0, y0, x1, y1]) => [...g.toPdf(x0, y0), ...g.toPdf(x1, y0), ...g.toPdf(x0, y1), ...g.toPdf(x1, y1)]);
    pages.push({ page, quads });
  }
  const text = range.toString();
  sel.removeAllRanges();
  return { text, pages };
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
