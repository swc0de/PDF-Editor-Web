// Prepare form (app.formEditor): draw new fields (text, checkbox, dropdown,
// signature), select, move, resize, edit properties and delete them. Every
// change is one undo step (worker ops in core/ops/form-ops.js).
import { h } from '../dom.js';
import { icon } from '../icons.js';
import { t } from '../../i18n/index.js';
import { toast } from '../toast.js';
import { pageGeometry } from '../annotate/annotator.js';
import { openFieldDialog } from './field-dialog.js';

export const FIELD_TOOLS = ['select', 'text', 'checkbox', 'dropdown', 'signature'];
const TOOL_ICONS = { select: 'mousePointer', text: 'textInput', checkbox: 'checkSquare', dropdown: 'listDown', signature: 'signature' };
const norm = (r) => [Math.min(r[0], r[2]), Math.min(r[1], r[3]), Math.max(r[0], r[2]), Math.max(r[1], r[3])];
const FIXED_KINDS = new Set(['checkbox', 'radio']);

export class FormEditor extends EventTarget {
  constructor(app) {
    super();
    this.app = app;
    this.tool = null;
    this.selection = null; // { tabId, page, id, name }
    this.toolbar = this.buildToolbar();
    app.shell.main.append(this.toolbar.el);
    app.shell.main.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    app.shell.main.addEventListener('dblclick', (e) => {
      if (!this.tool) return;
      const box = e.target.closest?.('.form-field');
      if (box) this.editProperties();
    });
    app.addEventListener('tabchange', () => {
      this.deselect();
      if (!this.tab) this.deactivate();
      else this.syncHost();
    });
    app.addEventListener('organizerchange', () => {
      if (app.organizerOpen) this.deactivate();
    });
    app.addEventListener('documentopened', (e) => {
      const viewer = e.detail.tab.viewer;
      const reframe = () => requestAnimationFrame(() => {
        this.renderSelection();
        if (this.tool) this.toolbar.sync();
      });
      for (const type of ['annotations', 'zoomchange', 'layoutchange', 'docchange']) viewer.addEventListener(type, reframe);
    });
  }

  get tab() {
    return this.app.activeTab;
  }

  activate(tool = 'select') {
    const tab = this.tab;
    if (!tab) return toast(t('forms.needsDocument'));
    if (tab.model.readOnly) return toast(t(`edit.readOnly.${tab.model.readOnly}`), { kind: 'error' });
    this.app.closeOrganizer?.();
    this.app.annotator?.deactivate();
    this.app.forms?.cancelPlacing();
    this.tool = tool;
    if (tool !== 'select') this.deselect();
    this.syncHost();
    this.toolbar.show();
    this.toolbar.sync();
    this.dispatchEvent(new CustomEvent('toolchange'));
  }

  deactivate() {
    if (!this.tool) return;
    this.tool = null;
    this.deselect();
    this.syncHost();
    this.toolbar.hide();
    this.dispatchEvent(new CustomEvent('toolchange'));
  }

  syncHost() {
    for (const tab of this.app.tabs) {
      const on = tab === this.tab && !!this.tool;
      tab.host.classList.toggle('form-editing', on);
      tab.host.classList.toggle('form-drawing', on && this.tool !== 'select');
    }
  }

  // ---------------------------------------------------------- selection

  widgetData(sel = this.selection) {
    const tab = this.tab;
    if (!sel || !tab || tab.id !== sel.tabId) return null;
    const view = tab.viewer.views[sel.page];
    const data = view?.widgets?.find((w) => w.id === sel.id);
    return data ? { tab, view, data } : null;
  }

  select(page, id, name) {
    this.selection = { tabId: this.tab.id, page, id, name };
    this.renderSelection();
    this.toolbar.sync();
    this.dispatchEvent(new CustomEvent('selectionchange'));
  }

  deselect() {
    if (!this.selection) return;
    this.selection = null;
    this.renderSelection();
    this.toolbar.sync();
    this.dispatchEvent(new CustomEvent('selectionchange'));
  }

  renderSelection() {
    for (const el of document.querySelectorAll('.field-selection')) el.remove();
    const sel = this.widgetData();
    if (!sel || !this.tool) return;
    const g = pageGeometry(sel.tab.viewer, sel.view);
    const [x0, y0, x1, y1] = g.toCss(sel.data.rect);
    const resizable = !FIXED_KINDS.has(kind(sel.data));
    const frame = h('div.annot-selection.movable.field-selection', { 'aria-hidden': 'true' },
      resizable ? ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'].map((p) => h(`span.annot-handle.h-${p}`, { dataset: { handle: p } })) : null);
    Object.assign(frame.style, { left: `${x0 - 3}px`, top: `${y0 - 3}px`, width: `${x1 - x0 + 6}px`, height: `${y1 - y0 + 6}px` });
    sel.view.el.append(frame);
  }

  // -------------------------------------------------------------- input

  pageAt(target) {
    const pageEl = target.closest?.('.page');
    const tab = this.tab;
    if (!pageEl || !tab || !tab.host.contains(pageEl)) return null;
    const view = tab.viewer.views[Number(pageEl.dataset.pageNumber) - 1];
    return view?.baseViewport ? pageGeometry(tab.viewer, view) : null;
  }

  onPointerDown(e) {
    if (!this.tool || e.button !== 0) return;
    if (e.target.closest('.form-toolbar, .side-panel, .find-bar, dialog')) return;
    const handle = e.target.closest('.field-selection .annot-handle');
    const frame = e.target.closest('.field-selection');
    if (handle || frame) {
      e.preventDefault();
      this.startTransform(e, handle?.dataset.handle ?? 'move');
      return;
    }
    const g = this.pageAt(e.target);
    if (this.tool !== 'select') {
      if (g) this.startDraw(e, g);
      return;
    }
    const box = e.target.closest('.form-field');
    if (box && g) {
      e.preventDefault();
      this.select(g.page, box.dataset.widgetId, box.dataset.fieldName);
      this.startTransform(e, 'move');
      return;
    }
    if (g) this.deselect();
  }

  startTransform(e, mode) {
    const sel = this.widgetData();
    if (!sel) return;
    const g = pageGeometry(sel.tab.viewer, sel.view);
    const start = g.toCss(sel.data.rect);
    const [sx, sy] = g.local(e.clientX, e.clientY);
    const frame = sel.view.el.querySelector('.field-selection');
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
        if (mode.includes('w')) x0 = Math.min(x1 - 6, x0 + dx);
        if (mode.includes('e')) x1 = Math.max(x0 + 6, x1 + dx);
        if (mode.includes('n')) y0 = Math.min(y1 - 6, y0 + dy);
        if (mode.includes('s')) y1 = Math.max(y0 + 6, y1 + dy);
      }
      box = [x0, y0, x1, y1];
      frame?.classList.add('dragging');
      if (frame) Object.assign(frame.style, { left: `${x0 - 3}px`, top: `${y0 - 3}px`, width: `${x1 - x0 + 6}px`, height: `${y1 - y0 + 6}px` });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      frame?.classList.remove('dragging');
      if (!moved) return;
      const label = t(mode === 'move' ? 'step.moveField' : 'step.resizeField', { name: sel.data.fieldName });
      this.app.edit(sel.tab, 'setWidgetRect', { id: sel.data.id, rect: g.cssToPdfRect(box) }, label);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  startDraw(e, g) {
    e.preventDefault();
    const tool = this.tool;
    const [x, y] = g.local(e.clientX, e.clientY);
    const draft = h('div.field-draft', { 'aria-hidden': 'true' });
    g.view.el.append(draft);
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
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      draft.remove();
      const s = this.tab.viewer.layout.scale;
      let box = norm([x, y, end[0], end[1]]);
      // A click (or a tiny drag) gets the kind's default size.
      if (box[2] - box[0] < 6 && box[3] - box[1] < 6) {
        const size = { text: [180, 22], checkbox: [14, 14], dropdown: [150, 22], signature: [200, 50] }[tool];
        box = [x, y, x + size[0] * s, y + size[1] * s];
      }
      if (tool === 'checkbox') {
        const side = Math.max(box[2] - box[0], box[3] - box[1]);
        box = [box[0], box[1], box[0] + side, box[1] + side];
      }
      const result = await this.app.edit(this.tab, 'addField', { page: g.page, kind: tool, rect: g.cssToPdfRect(box) }, t('step.addField', { type: t(`fieldKind.${tool}`) }));
      if (result?.id) {
        this.tool = 'select';
        this.syncHost();
        this.select(g.page, result.id, result.name);
        this.toolbar.sync();
        if (tool === 'dropdown') this.editProperties();
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  // ------------------------------------------------------------ actions

  async editProperties() {
    const tab = this.tab;
    const name = this.selection?.tabId === tab?.id ? this.selection.name : null;
    if (!name) return;
    const info = await tab.model.query('fieldInfo', { name }).catch(() => null);
    if (!info) return;
    const prefix = info.name.slice(0, info.name.length - info.partialName.length);
    const fields = await (tab.fieldsPromise ?? this.app.forms.loadFields(tab));
    const otherNames = new Set(fields.filter((f) => f.name !== info.name && f.name.startsWith(prefix)).map((f) => f.name.slice(prefix.length)));
    const changes = await openFieldDialog({ info, otherNames });
    if (!changes || !Object.keys(changes).length) return;
    const result = await this.app.edit(tab, 'setFieldProps', { name: info.name, ...changes }, t('step.fieldProps', { name: info.name }));
    if (result?.name && this.selection) this.selection.name = result.name;
  }

  async deleteSelected() {
    const sel = this.widgetData();
    if (!sel) return;
    this.deselect();
    await this.app.edit(sel.tab, 'removeField', { name: sel.data.fieldName }, t('step.deleteField', { name: sel.data.fieldName }));
  }

  get canEscape() {
    return !!(this.selection || this.tool);
  }

  escape() {
    if (this.widgetData()) this.deselect();
    else this.deactivate();
  }

  // ------------------------------------------------------------ toolbar

  buildToolbar() {
    const buttons = new Map();
    const tools = FIELD_TOOLS.map((tool) => {
      const label = t(`formTool.${tool}`);
      const b = h('button.btn.icon-btn.annot-tool', {
        type: 'button', 'aria-pressed': 'false', 'aria-label': label, title: label, dataset: { tool },
        onclick: () => this.activate(tool),
      }, icon(TOOL_ICONS[tool]));
      buttons.set(tool, b);
      return b;
    });
    const props = h('button.btn.btn-sm', { type: 'button', onclick: () => this.editProperties() }, t('formTool.properties'));
    const del = h('button.btn.icon-btn', { type: 'button', 'aria-label': t('formTool.delete'), title: `${t('formTool.delete')} (Del)`, onclick: () => this.deleteSelected() }, icon('trash'));
    const fieldsBtn = h('button.btn.icon-btn', { type: 'button', 'aria-label': t('forms.openFields'), title: t('forms.openFields'), onclick: () => this.app.showPanel('fields') }, icon('textInput'));
    const done = h('button.btn.annot-done', { type: 'button', title: `${t('annot.done')} (Esc)`, onclick: () => this.deactivate() }, t('annot.done'));
    const selName = h('span.form-selected-name');
    const hint = h('span.annot-hint.form-hint', { role: 'status', 'aria-live': 'polite' });
    const el = h('div.annot-toolbar.form-toolbar', { role: 'toolbar', 'aria-label': t('formTool.toolbar'), hidden: true },
      h('div.annot-group', { role: 'group' }, tools[0]),
      h('div.annot-group', { role: 'group' }, tools.slice(1)),
      h('span.annot-sep', { 'aria-hidden': 'true' }),
      selName, props, hint,
      h('div.annot-actions', del, fieldsBtn, done));
    el.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      const items = [...el.querySelectorAll('button')].filter((b) => !b.disabled && b.offsetParent);
      const i = items.indexOf(document.activeElement);
      if (i < 0) return;
      e.preventDefault();
      items[(i + (e.key === 'ArrowRight' ? 1 : -1) + items.length) % items.length].focus();
    });
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
        if (!this.app.annotator?.tool) main.classList.remove('annot-on');
      },
      sync: () => {
        for (const [id, b] of buttons) b.setAttribute('aria-pressed', String(id === this.tool));
        const sel = this.widgetData();
        props.hidden = !sel;
        del.hidden = !sel;
        selName.hidden = !sel;
        selName.textContent = sel ? sel.data.fieldName : '';
        hint.textContent = sel ? '' : t(`formTool.hint.${this.tool || 'select'}`);
      },
    };
  }
}

function kind(data) {
  if (data.fieldType === 'Btn') return data.checkBox ? 'checkbox' : data.radioButton ? 'radio' : 'button';
  return data.fieldType;
}
