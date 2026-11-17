// Organize pages: a full-viewport grid of page thumbnails for one tab.
//
// The grid is windowed: only the rows near the visible area exist in the DOM
// (absolutely positioned in a tall spacer), so 1000-page documents stay light.
// Focus stays on the listbox and aria-activedescendant points at the focused
// tile, which is always kept rendered.
//
// Every action goes through app.edit() → one named undo step.
import { h } from '../dom.js';
import { icon } from '../icons.js';
import { t, tn } from '../../i18n/index.js';
import { formatShortcut } from '../keys.js';
import { openMenu } from '../menu.js';
import { toast } from '../toast.js';
import { getPref, setPref } from '../../core/prefs.js';
import { rotatedSize } from '../../view/layout.js';
import { moveSelection, nudgeSelection } from '../../core/page-order.js';
import { formatPageRange } from '../../core/page-range.js';
import { getThumb } from '../thumbnails.js';
import { openInsertDialog } from './insert-dialog.js';

const SIZE = { min: 60, max: 160, step: 10, default: 100 };
const BASE_TILE = 140; // px at 100%
const GAP = 20;
const PAD = 24;
const LABEL_H = 26;
const BUFFER_ROWS = 2;
const DRAG_THRESHOLD = 6;
const A4 = [595.28, 841.89];
const LETTER = [612, 792];

let uid = 0;

export class Organizer {
  constructor(app, tab) {
    this.app = app;
    this.tab = tab;
    this.viewer = tab.viewer;
    this.id = `org${++uid}`;
    this.selection = new Set();
    this.anchor = null;
    this.focus = 0;
    this.size = getPref('organizeSize', SIZE.default);
    this.tiles = new Map(); // index → { el, frame, page }
    this.thumbQueue = [];
    this.thumbBusy = false;
    this.pendingSelection = null;
    this.drag = null;
    this.build();
    this.bind();
  }

  get count() {
    return this.viewer.numPages;
  }

  // ------------------------------------------------------------- DOM

  build() {
    const btn = (name, labelKey, onclick, { shortcut, text } = {}) => {
      const label = t(labelKey);
      return h(`button.btn${text ? '' : '.icon-btn'}.org-btn`, {
        type: 'button',
        'aria-label': text ? null : label,
        title: shortcut ? `${label} (${formatShortcut(shortcut)})` : label,
        onclick,
        dataset: { action: labelKey.split('.').pop() },
      }, icon(name), text ? h('span', label) : null);
    };
    this.countEl = h('span.org-count', { role: 'status', 'aria-live': 'polite' });
    this.selectBtn = h('button.btn.ghost.org-menu-btn', {
      type: 'button', 'aria-haspopup': 'menu', 'aria-expanded': 'false', onclick: () => this.openSelectMenu(),
    }, t('organize.select'), icon('chevronDown', { size: 14 }));
    this.insertBtn = h('button.btn.ghost.org-menu-btn', {
      type: 'button', 'aria-haspopup': 'menu', 'aria-expanded': 'false', onclick: () => this.openInsertMenu(),
    }, icon('filePlus'), t('organize.insert'), icon('chevronDown', { size: 14 }));
    this.actionBtns = [
      btn('rotateCcw', 'organize.rotateLeft', () => this.rotate(-90)),
      btn('rotateCw', 'organize.rotateRight', () => this.rotate(90)),
      btn('copy', 'organize.duplicate', () => this.duplicate(), { shortcut: 'Mod+D' }),
      btn('trash', 'organize.delete', () => this.remove(), { shortcut: 'Delete' }),
      btn('fileOutput', 'organize.extract', () => this.extract(), { text: true }),
    ];
    this.slider = h('input.org-size', {
      type: 'range', min: String(SIZE.min), max: String(SIZE.max), step: String(SIZE.step),
      value: String(this.size), 'aria-label': t('organize.size'), title: t('organize.size'),
    });
    this.doneBtn = h('button.btn.primary', { type: 'button', title: `${t('organize.done')} (Esc)`, onclick: () => this.app.closeOrganizer() },
      icon('check'), t('organize.done'));

    this.toolbar = h('div.org-toolbar', { role: 'toolbar', 'aria-label': t('organize.title') },
      h('h2.org-title', icon('layoutPages'), t('organize.title')),
      this.countEl,
      h('span.org-sep'),
      this.selectBtn,
      h('span.org-sep'),
      this.actionBtns.slice(0, 4),
      this.insertBtn,
      this.actionBtns[4],
      h('span.org-spacer'),
      icon('grid', { size: 14 }),
      this.slider,
      this.doneBtn,
    );

    this.grid = h('div.org-grid', {
      id: `${this.id}-grid`,
      role: 'listbox',
      tabindex: '0',
      'aria-multiselectable': 'true',
      'aria-label': t('organize.pages'),
      'aria-describedby': `${this.id}-help`,
    });
    this.dropIndicator = h('div.org-drop', { hidden: true, 'aria-hidden': 'true' });
    this.spacer = h('div.org-spacer-box', this.grid, this.dropIndicator);
    this.scroller = h('div.org-scroller', this.spacer);
    this.help = h('p.org-help', { id: `${this.id}-help` }, t('organize.help'));
    this.el = h('section.organizer', { hidden: true, 'aria-label': t('organize.title') },
      this.toolbar, this.scroller, this.help);
    this.tab.host.append(this.el);
  }

  bind() {
    this.scroller.addEventListener('scroll', () => this.renderVisible(), { passive: true });
    this.resizeObserver = new ResizeObserver(() => this.layout());
    this.resizeObserver.observe(this.scroller);
    this.slider.addEventListener('input', () => {
      this.size = Number(this.slider.value);
      setPref('organizeSize', this.size);
      this.layout();
      this.revealFocus();
    });
    this.grid.addEventListener('keydown', (e) => this.handleKey(e));
    this.grid.addEventListener('click', (e) => this.handleClick(e));
    this.grid.addEventListener('dblclick', (e) => {
      const i = this.indexFromEvent(e);
      if (i !== null) this.openPage(i);
    });
    this.scroller.addEventListener('pointerdown', (e) => this.handlePointerDown(e));
    this.onDocChange = () => this.refresh();
    this.onBusy = () => this.syncToolbar();
    this.tab.addEventListener('docchange', this.onDocChange);
    this.tab.model.addEventListener('busychange', this.onBusy);
  }

  show() {
    this.el.hidden = false;
    this.viewer.container.hidden = true;
    if (!this.selection.size) {
      this.focus = this.viewer.current;
      this.select([this.focus]);
    }
    this.layout();
    this.revealFocus();
    this.grid.focus({ preventScroll: true });
  }

  hide() {
    this.el.hidden = true;
    this.viewer.container.hidden = false;
    this.viewer.scheduleUpdate();
  }

  get isOpen() {
    return !this.el.hidden;
  }

  destroy() {
    this.resizeObserver.disconnect();
    this.tab.removeEventListener('docchange', this.onDocChange);
    this.tab.model.removeEventListener('busychange', this.onBusy);
    this.el.remove();
  }

  // ------------------------------------------------------------ layout

  metrics() {
    const tile = Math.round((BASE_TILE * this.size) / 100);
    const cellW = tile + GAP;
    const cellH = Math.round(tile * 1.3) + LABEL_H + GAP;
    const avail = Math.max(1, this.scroller.clientWidth - PAD * 2 + GAP);
    const cols = Math.max(1, Math.floor(avail / cellW));
    const rows = Math.ceil(this.count / cols);
    const left = PAD + Math.max(0, Math.floor((avail - cols * cellW) / 2));
    return { tile, cellW, cellH, cols, rows, left };
  }

  layout() {
    if (!this.isOpen) return;
    this.m = this.metrics();
    this.spacer.style.height = `${PAD * 2 + this.m.rows * this.m.cellH - GAP}px`;
    for (const tile of this.tiles.values()) tile.el.remove();
    this.tiles.clear();
    this.renderVisible();
  }

  tilePos(i) {
    const { cols, cellW, cellH, left } = this.m;
    return { x: left + (i % cols) * cellW, y: PAD + Math.floor(i / cols) * cellH };
  }

  renderVisible() {
    if (!this.isOpen || !this.m) return;
    const { cols, cellH } = this.m;
    const top = this.scroller.scrollTop - PAD;
    const firstRow = Math.max(0, Math.floor(top / cellH) - BUFFER_ROWS);
    const lastRow = Math.floor((top + this.scroller.clientHeight) / cellH) + BUFFER_ROWS;
    const wanted = new Set();
    for (let r = firstRow; r <= lastRow; r++) {
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c;
        if (i < this.count) wanted.add(i);
      }
    }
    wanted.add(this.focus); // aria-activedescendant must exist
    for (const [i, tile] of this.tiles) {
      if (!wanted.has(i)) {
        tile.el.remove();
        this.tiles.delete(i);
      }
    }
    const frag = document.createDocumentFragment();
    for (const i of wanted) {
      if (i >= this.count) continue;
      if (!this.tiles.has(i)) {
        const tile = this.createTile(i);
        this.tiles.set(i, tile);
        frag.append(tile.el);
      }
      this.syncTile(i);
    }
    this.grid.append(frag);
    this.pumpThumbs();
  }

  createTile(i) {
    const page = h('div.org-page');
    const frame = h('div.org-frame', page);
    const el = h('div.org-tile', {
      id: `${this.id}-tile-${i}`,
      role: 'option',
      dataset: { index: String(i) },
    }, frame, h('span.org-label'), h('span.org-check', { 'aria-hidden': 'true' }, icon('check', { size: 12 })));
    const tile = { el, frame, page, thumb: null };
    this.thumbQueue.push(i);
    return tile;
  }

  syncTile(i) {
    const tile = this.tiles.get(i);
    if (!tile) return;
    const { tile: w } = this.m;
    const { x, y } = this.tilePos(i);
    const s = rotatedSize(this.viewer.sizes[i], this.viewer.rotation);
    const boxH = Math.round(w * 1.3);
    const scale = Math.min(w / s.w, boxH / s.h);
    Object.assign(tile.el.style, { left: `${x}px`, top: `${y}px`, width: `${w}px` });
    tile.frame.style.height = `${boxH}px`;
    tile.page.style.width = `${Math.round(s.w * scale)}px`;
    tile.page.style.height = `${Math.round(s.h * scale)}px`;
    const label = this.viewer.pageLabel(i);
    tile.el.querySelector('.org-label').textContent = label;
    tile.el.setAttribute('aria-label', t('organize.tileLabel', { label, n: i + 1 }));
    tile.el.setAttribute('aria-posinset', String(i + 1));
    tile.el.setAttribute('aria-setsize', String(this.count));
    tile.el.setAttribute('aria-selected', String(this.selection.has(i)));
    tile.el.classList.toggle('focused', i === this.focus);
  }

  async pumpThumbs() {
    if (this.thumbBusy) return;
    this.thumbBusy = true;
    try {
      while (this.thumbQueue.length) {
        const i = this.thumbQueue.shift();
        const tile = this.tiles.get(i);
        if (!tile || tile.thumb) continue;
        let url = null;
        try {
          url = await getThumb(this.tab, i);
        } catch {
          tile.page.replaceChildren(icon('alertTriangle', { size: 18 }));
          tile.el.dataset.state = 'error';
          continue;
        }
        const now = this.tiles.get(i);
        if (now && url) {
          now.thumb = url;
          now.page.replaceChildren(h('img', { src: url, alt: '', draggable: false }));
          now.el.dataset.state = 'rendered';
        }
      }
    } finally {
      this.thumbBusy = false;
    }
  }

  /** The document changed (an edit, undo or redo): rebuild the grid. */
  refresh() {
    const n = this.count;
    const sel = this.pendingSelection ?? [...this.selection].filter((i) => i < n);
    this.pendingSelection = null;
    this.selection = new Set(sel);
    this.focus = Math.min(Math.max(0, sel.length ? sel.at(-1) : this.focus), n - 1);
    this.anchor = sel.length ? sel[0] : null;
    this.thumbQueue = [];
    if (this.isOpen) {
      this.layout();
      this.revealFocus();
    }
    this.syncToolbar();
  }

  // --------------------------------------------------------- selection

  select(indexes, { add = false } = {}) {
    if (!add) this.selection.clear();
    for (const i of indexes) if (i >= 0 && i < this.count) this.selection.add(i);
    this.syncSelection();
  }

  syncSelection() {
    for (const i of this.tiles.keys()) this.syncTile(i);
    const id = `${this.id}-tile-${this.focus}`;
    if (this.tiles.has(this.focus)) this.grid.setAttribute('aria-activedescendant', id);
    this.syncToolbar();
  }

  syncToolbar() {
    const n = this.selection.size;
    this.countEl.textContent = n ? t('organize.selected', { n, total: this.count }) : tn('organize.pageCount', this.count);
    const busy = this.tab.model.busy;
    const readOnly = !!this.tab.model.readOnly;
    for (const b of this.actionBtns) b.disabled = busy || readOnly || n === 0;
    this.insertBtn.disabled = busy || readOnly;
    this.el.dataset.busy = String(busy);
  }

  setFocus(i, { extend = false, toggle = false, keepSelection = false } = {}) {
    const n = this.count;
    i = Math.max(0, Math.min(n - 1, i));
    this.focus = i;
    if (extend) {
      if (this.anchor === null) this.anchor = i;
      const [a, b] = [Math.min(this.anchor, i), Math.max(this.anchor, i)];
      this.select(Array.from({ length: b - a + 1 }, (_, k) => a + k), { add: keepSelection });
    } else if (toggle) {
      if (this.selection.has(i)) this.selection.delete(i);
      else this.selection.add(i);
      this.anchor = i;
      this.syncSelection();
    } else if (!keepSelection) {
      this.anchor = i;
      this.select([i]);
    } else {
      this.syncSelection();
    }
    this.revealFocus();
  }

  revealFocus() {
    if (!this.m || !this.isOpen) return;
    const { y } = this.tilePos(this.focus);
    const top = this.scroller.scrollTop;
    const bottom = top + this.scroller.clientHeight;
    if (y < top + 4) this.scroller.scrollTop = y - PAD / 2;
    else if (y + this.m.cellH > bottom) this.scroller.scrollTop = y + this.m.cellH - this.scroller.clientHeight + PAD / 2;
    this.renderVisible();
    this.syncSelection();
  }

  selectAll() {
    this.select([...Array(this.count).keys()]);
  }

  selectNone() {
    this.select([]);
  }

  invert() {
    this.select([...Array(this.count).keys()].filter((i) => !this.selection.has(i)));
  }

  selectParity(odd) {
    // "Odd pages" means page numbers 1, 3, 5… (indexes 0, 2, 4…)
    this.select([...Array(this.count).keys()].filter((i) => (i % 2 === 0) === odd));
  }

  openSelectMenu() {
    openMenu(this.selectBtn, [
      { id: 'select-all', label: t('organize.selectAll'), shortcut: 'Mod+A', run: () => this.selectAll() },
      { id: 'select-none', label: t('organize.selectNone'), run: () => this.selectNone() },
      { id: 'select-invert', label: t('organize.invert'), run: () => this.invert() },
      'separator',
      { id: 'select-odd', label: t('organize.odd'), run: () => this.selectParity(true) },
      { id: 'select-even', label: t('organize.even'), run: () => this.selectParity(false) },
    ], { label: t('organize.select') });
  }

  openInsertMenu() {
    openMenu(this.insertBtn, [
      { id: 'insert-before', label: t('organize.blankBefore'), run: () => this.insertBlank('before') },
      { id: 'insert-after', label: t('organize.blankAfter'), run: () => this.insertBlank('after') },
      'separator',
      { id: 'insert-a4', label: t('organize.blankA4'), run: () => this.insertBlank('after', A4) },
      { id: 'insert-letter', label: t('organize.blankLetter'), run: () => this.insertBlank('after', LETTER) },
      'separator',
      { id: 'insert-pdf', label: t('organize.fromPdf'), icon: 'files', run: () => this.insertFromPdf() },
    ], { label: t('organize.insert') });
  }

  // ----------------------------------------------------------- actions

  selected() {
    return [...this.selection].sort((a, b) => a - b);
  }

  async run(op, args, label, nextSelection) {
    // Keep keyboard control in the grid after a toolbar click.
    this.grid.focus({ preventScroll: true });
    this.pendingSelection = nextSelection;
    const ok = await this.app.edit(this.tab, op, args, label);
    if (!ok) this.pendingSelection = null;
    return ok;
  }

  rotate(delta) {
    const pages = this.selected();
    if (!pages.length) return;
    const key = delta > 0 ? 'step.rotatePages' : 'step.rotatePagesLeft';
    return this.run('rotatePages', { pages, delta }, tn(key, pages.length), pages);
  }

  remove() {
    const pages = this.selected();
    if (!pages.length) return;
    if (pages.length >= this.count) {
      toast(t('organize.cantDeleteAll'), { kind: 'error' });
      return;
    }
    const keep = Math.min(pages[0], this.count - pages.length - 1);
    this.focus = keep;
    return this.run('deletePages', { pages }, tn('step.deletePages', pages.length), [keep]);
  }

  duplicate() {
    const pages = this.selected();
    if (!pages.length) return;
    const copies = pages.map((p, k) => p + k + 1);
    return this.run('duplicatePages', { pages }, tn('step.duplicatePages', pages.length), copies);
  }

  reference(where) {
    const sel = this.selected();
    if (sel.length) return where === 'before' ? sel[0] : sel.at(-1);
    return Math.min(this.focus, this.count - 1);
  }

  insertBlank(where, size = null) {
    const ref = this.reference(where);
    const at = where === 'before' ? ref : ref + 1;
    const neighbour = this.viewer.sizes[ref];
    const args = size
      ? { at, size }
      : { at, size: [neighbour.w, neighbour.h], rotate: neighbour.rotate ?? 0 };
    return this.run('insertBlank', args, t('step.insertBlank'), [at]);
  }

  async insertFromPdf() {
    const sel = this.selected();
    const choice = await openInsertDialog({ count: this.count, defaultAfter: sel.length ? sel.at(-1) + 1 : this.count });
    this.grid.focus({ preventScroll: true });
    if (!choice) return;
    const n = choice.pages.length;
    const inserted = Array.from({ length: n }, (_, k) => choice.at + k);
    return this.run('insertFromPdf', { at: choice.at, bytes: choice.bytes, pages: choice.pages },
      tn('step.insertPages', n, { name: choice.name }), inserted);
  }

  reorder(result) {
    if (!result.changed) return;
    return this.run('reorderPages', { order: result.order }, tn('step.movePages', result.selection.length), result.selection);
  }

  nudge(dir) {
    const result = nudgeSelection(this.count, this.selected(), dir);
    if (result.changed) {
      this.focus = dir < 0 ? result.selection[0] : result.selection.at(-1);
      return this.reorder(result);
    }
  }

  async extract() {
    const pages = this.selected();
    if (!pages.length) return;
    try {
      const { bytes } = await this.tab.model.query('exportPages', { pages });
      const base = this.tab.name.replace(/\.pdf$/i, '');
      const name = `${base} (${tn('organize.extractName', pages.length, { range: formatPageRange(pages) })}).pdf`;
      await this.app.openBytes(bytes, name, { clean: false, openLabel: t('history.extracted', { name: this.tab.name }) });
    } catch (err) {
      toast(t('edit.failed', { message: err.message }), { kind: 'error' });
    }
  }

  openPage(i) {
    this.app.closeOrganizer();
    this.viewer.navigate(i + 1);
  }

  // ------------------------------------------------------- input

  indexFromEvent(e) {
    const tile = e.target.closest?.('.org-tile');
    return tile ? Number(tile.dataset.index) : null;
  }

  handleClick(e) {
    if (this.suppressClick) {
      this.suppressClick = false;
      return;
    }
    const i = this.indexFromEvent(e);
    if (i === null) {
      if (e.target === this.grid || e.target === this.spacer) this.selectNone();
      return;
    }
    const mod = e.ctrlKey || e.metaKey;
    if (e.shiftKey) this.setFocus(i, { extend: true, keepSelection: mod });
    else if (mod) this.setFocus(i, { toggle: true });
    else this.setFocus(i);
    this.grid.focus({ preventScroll: true });
  }

  handleKey(e) {
    if (this.drag) {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        this.endDrag(false);
      }
      return;
    }
    const mod = e.ctrlKey || e.metaKey;
    const cols = this.m?.cols ?? 1;
    const k = e.key;
    let handled = true;
    if (mod && (k === 'ArrowLeft' || k === 'ArrowRight')) this.nudge(k === 'ArrowLeft' ? -1 : 1);
    else if (mod && (k === 'a' || k === 'A')) this.selectAll();
    else if (mod && (k === 'd' || k === 'D')) this.duplicate();
    else if (k === 'Delete' || k === 'Backspace') this.remove();
    else if (k === 'ArrowLeft') this.setFocus(this.focus - 1, { extend: e.shiftKey });
    else if (k === 'ArrowRight') this.setFocus(this.focus + 1, { extend: e.shiftKey });
    else if (k === 'ArrowUp') this.setFocus(this.focus - cols, { extend: e.shiftKey });
    else if (k === 'ArrowDown') this.setFocus(this.focus + cols, { extend: e.shiftKey });
    else if (k === 'Home') this.setFocus(0, { extend: e.shiftKey });
    else if (k === 'End') this.setFocus(this.count - 1, { extend: e.shiftKey });
    else if (k === ' ' && !mod) this.setFocus(this.focus, { toggle: true });
    else if (k === 'Enter') this.openPage(this.focus);
    else if (k === 'Escape') this.app.closeOrganizer();
    else handled = false;
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  }

  // ------------------------------------------------- drag and drop

  handlePointerDown(e) {
    if (e.button !== 0) return;
    const i = this.indexFromEvent(e);
    if (i === null || this.tab.model.readOnly) return;
    const start = { x: e.clientX, y: e.clientY, index: i, pointerId: e.pointerId };
    const move = (ev) => {
      if (!this.drag) {
        if (Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < DRAG_THRESHOLD) return;
        this.startDrag(start);
      }
      this.updateDrag(ev);
    };
    const up = (ev) => {
      cleanup();
      if (this.drag) {
        this.updateDrag(ev);
        this.endDrag(true);
      }
    };
    const cancel = () => {
      cleanup();
      if (this.drag) this.endDrag(false);
    };
    const cleanup = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
  }

  startDrag(start) {
    if (!this.selection.has(start.index)) {
      this.focus = start.index;
      this.anchor = start.index;
      this.select([start.index]);
    }
    const pages = this.selected();
    const thumb = this.tiles.get(start.index)?.thumb;
    const ghost = h('div.org-ghost', { 'aria-hidden': 'true' },
      thumb ? h('img', { src: thumb, alt: '' }) : h('div.org-ghost-blank'),
      h('span.org-ghost-count', String(pages.length)));
    document.body.append(ghost);
    this.drag = { pages, ghost, target: null, scrollTimer: 0 };
    this.el.classList.add('dragging');
    for (const i of pages) this.tiles.get(i)?.el.classList.add('drag-source');
    this.grid.focus({ preventScroll: true });
  }

  updateDrag(ev) {
    const d = this.drag;
    d.ghost.style.transform = `translate(${ev.clientX + 12}px, ${ev.clientY + 12}px)`;
    d.lastEvent = ev;
    const rect = this.spacer.getBoundingClientRect();
    const x = ev.clientX - rect.left;
    const y = ev.clientY - rect.top;
    const { cols, cellW, cellH, left, tile } = this.m;
    const row = Math.max(0, Math.min(this.m.rows - 1, Math.floor((y - PAD + GAP / 2) / cellH)));
    const colF = (x - left + GAP / 2) / cellW;
    const col = Math.max(0, Math.min(cols, Math.round(colF)));
    const target = Math.max(0, Math.min(this.count, row * cols + col));
    d.target = target;
    // Indicator: a bar in the gap before tile `target` (or after the last one).
    const ref = target === this.count || col === cols ? target - 1 : target;
    const pos = this.tilePos(Math.max(0, ref));
    const after = target === this.count || col === cols;
    Object.assign(this.dropIndicator.style, {
      left: `${(after ? pos.x + tile + GAP / 2 : pos.x - GAP / 2) - 2}px`,
      top: `${pos.y}px`,
      height: `${Math.round(tile * 1.3) + LABEL_H}px`,
    });
    this.dropIndicator.hidden = false;
    this.dropIndicator.dataset.target = String(target);
    this.autoScroll(ev);
  }

  autoScroll(ev) {
    const d = this.drag;
    const r = this.scroller.getBoundingClientRect();
    const edge = 48;
    let speed = 0;
    if (ev.clientY < r.top + edge) speed = -Math.ceil((r.top + edge - ev.clientY) / 4);
    else if (ev.clientY > r.bottom - edge) speed = Math.ceil((ev.clientY - (r.bottom - edge)) / 4);
    cancelAnimationFrame(d.scrollTimer);
    if (!speed) return;
    const step = () => {
      if (!this.drag) return;
      this.scroller.scrollTop += speed;
      this.updateDrag(d.lastEvent);
    };
    d.scrollTimer = requestAnimationFrame(step);
  }

  endDrag(commit) {
    const d = this.drag;
    this.drag = null;
    cancelAnimationFrame(d.scrollTimer);
    d.ghost.remove();
    this.dropIndicator.hidden = true;
    this.el.classList.remove('dragging');
    for (const tile of this.tiles.values()) tile.el.classList.remove('drag-source');
    this.suppressClick = true;
    setTimeout(() => { this.suppressClick = false; }, 0);
    if (commit && d.target !== null) {
      const result = moveSelection(this.count, d.pages, d.target);
      if (result.changed) {
        this.focus = result.selection[0];
        this.reorder(result);
      }
    }
  }
}
