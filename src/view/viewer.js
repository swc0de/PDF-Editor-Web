// The document viewer: virtualized pages in a scroll container, zoom (incl.
// pinch / ctrl+wheel anchored at the cursor), layouts, rotation, navigation,
// and a small render scheduler that only draws what's visible (± a margin).
import { computeLayout, visibleRows, pageAtPoint, rotatedSize, CSS_UNITS } from './layout.js';
import { PageView } from './page-view.js';
import { h } from '../ui/dom.js';
import { t } from '../i18n/index.js';

export const ZOOM_LEVELS = [0.1, 0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5, 6, 8, 10];
export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 10;
export const ZOOM_MODES = ['auto', 'fit-width', 'fit-page'];

const GAP = 16;
const PREFETCH = 2; // render visible pages ± this many
const KEEP = 6; // keep rendered pages within ± this many, release the rest
const MAX_CONCURRENT = 2;
const RERENDER_DELAY = 140; // ms of zoom quiet before re-rendering sharply
const MAX_AUTO_ZOOM = 1.25;
const SIZE_BATCH = 24;
const DEFAULT_SIZE = { w: 612, h: 792, rotate: 0 };

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function sizeOf(proxy) {
  const [x0, y0, x1, y1] = proxy.view;
  const unit = proxy.userUnit ?? 1;
  return { w: (x1 - x0) * unit, h: (y1 - y0) * unit, rotate: proxy.rotate ?? 0 };
}

export class Viewer extends EventTarget {
  /**
   * @param {HTMLElement} host  element to fill with the viewer
   * @param {object} o
   * @param {object} o.pdfjs
   * @param {object} o.doc     PDFDocumentProxy
   */
  constructor(host, { pdfjs, doc, zoom = 'auto', mode = 'continuous', cover = false, rotation = 0 }) {
    super();
    this.pdfjs = pdfjs;
    this.doc = doc;
    this.numPages = doc.numPages;
    this.zoomMode = zoom;
    this.zoom = 1;
    this.mode = mode;
    this.cover = cover;
    this.rotation = rotation;
    this.current = 0;
    this.layout = null;
    this.destroyed = false;
    this.running = 0;
    this.queue = [];
    this.raf = 0;
    this.holdUntil = 0;
    this.holdTimer = 0;
    this.pagePromises = new Map();
    this.sizes = new Array(this.numPages).fill(DEFAULT_SIZE);

    this.content = h('div.viewer-content');
    this.container = h(
      'div.viewer',
      { tabindex: '0', role: 'region', 'aria-label': t('viewer.label') },
      this.content,
    );
    host.append(this.container);

    this.views = Array.from(
      { length: this.numPages },
      (_, i) => new PageView(i, { pdfjs, getPage: (idx) => this.getPage(idx) }),
    );
    const frag = document.createDocumentFragment();
    for (const v of this.views) frag.append(v.el);
    this.content.append(frag);

    this.onScroll = () => this.scheduleUpdate();
    this.onWheel = (e) => this.handleWheel(e);
    this.onKey = (e) => this.handleKey(e);
    this.onClick = (e) => this.handleClick(e);
    this.container.addEventListener('scroll', this.onScroll, { passive: true });
    this.container.addEventListener('wheel', this.onWheel, { passive: false });
    this.container.addEventListener('keydown', this.onKey);
    this.content.addEventListener('click', this.onClick);
    this.bindGestures();
    this.resizeObserver = new ResizeObserver(() => this.handleResize());
    this.resizeObserver.observe(this.container);
  }

  /** Load the first page's size, lay out, render, then fetch other sizes. */
  async init() {
    try {
      const first = await this.getPage(0);
      this.sizes.fill(sizeOf(first));
    } catch {
      /* page 1 is broken: keep the default size, it shows an error tile */
    }
    if (this.destroyed) return;
    this.zoom = this.resolveZoom(this.zoomMode);
    this.relayout(null);
    this.emit('zoomchange');
    this.emit('pagechange');
    this.sizesLoaded = this.loadAllSizes();
  }

  getPage(index) {
    if (!this.pagePromises.has(index)) {
      const p = this.doc.getPage(index + 1);
      p.then(
        (proxy) => this.views[index]?.setProxy(proxy),
        (err) => this.views[index]?.setError(err),
      );
      this.pagePromises.set(index, p);
    }
    return this.pagePromises.get(index);
  }

  /** Fetch every page's real size in the background, in batches. */
  async loadAllSizes() {
    for (let start = 1; start < this.numPages; start += SIZE_BATCH) {
      if (this.destroyed) return;
      const batch = [];
      for (let i = start; i < Math.min(this.numPages, start + SIZE_BATCH); i++) batch.push(i);
      const results = await Promise.allSettled(batch.map((i) => this.getPage(i)));
      if (this.destroyed) return;
      let changed = false;
      results.forEach((r, k) => {
        if (r.status !== 'fulfilled') return;
        const size = sizeOf(r.value);
        const old = this.sizes[batch[k]];
        if (size.w !== old.w || size.h !== old.h || size.rotate !== old.rotate) {
          this.sizes[batch[k]] = size;
          changed = true;
        }
      });
      if (changed) {
        if (ZOOM_MODES.includes(this.zoomMode)) this.zoom = this.resolveZoom(this.zoomMode);
        this.relayout(this.captureAnchor(0, 0));
      }
    }
    this.emit('sizesloaded');
  }

  // ------------------------------------------------------------ layout

  relayout(anchor) {
    this.layout = computeLayout(this.sizes, {
      zoom: this.zoom,
      rotation: this.rotation,
      mode: this.mode,
      cover: this.cover,
      current: this.current,
      gap: GAP,
    });
    this.content.style.width = `${this.layout.width}px`;
    this.content.style.height = `${this.layout.height}px`;
    this.content.style.setProperty('--scale-factor', String(this.layout.scale));
    this.views.forEach((v, i) => v.setLayout(this.layout.items[i], this.layout.scale));
    if (anchor) this.restoreAnchor(anchor);
    this.update();
  }

  /** Remember which point of which page is at viewport position (vx, vy). */
  captureAnchor(vx, vy) {
    if (!this.layout) return null;
    const cx = this.container.scrollLeft + vx - this.content.offsetLeft;
    const cy = this.container.scrollTop + vy - this.content.offsetTop;
    const idx = pageAtPoint(this.layout, cx, cy);
    const it = this.layout.items[idx];
    if (!it) return null;
    return { idx, fx: (cx - it.x) / it.w, fy: (cy - it.y) / it.h, vx, vy };
  }

  restoreAnchor({ idx, fx, fy, vx, vy }) {
    const it = this.layout.items[idx];
    if (!it) return;
    this.container.scrollLeft = this.content.offsetLeft + it.x + fx * it.w - vx;
    this.container.scrollTop = this.content.offsetTop + it.y + fy * it.h - vy;
  }

  centerAnchor() {
    return this.captureAnchor(this.container.clientWidth / 2, this.container.clientHeight / 2);
  }

  // -------------------------------------------------------------- zoom

  resolveZoom(mode) {
    if (typeof mode === 'number') return clamp(mode, MIN_ZOOM, MAX_ZOOM);
    const row = this.rowPages(this.current);
    const sizes = row.map((i) => rotatedSize(this.sizes[i], this.rotation));
    const rowW = sizes.reduce((s, d) => s + d.w, 0) * CSS_UNITS;
    const rowH = Math.max(...sizes.map((d) => d.h)) * CSS_UNITS;
    const availW = this.container.clientWidth - GAP * 2 - GAP * (row.length - 1);
    const availH = this.container.clientHeight - GAP * 2;
    const fitW = availW / rowW;
    const fitP = Math.min(fitW, availH / rowH);
    let z;
    if (mode === 'fit-width') z = fitW;
    else if (mode === 'fit-page') z = fitP;
    else z = sizes[0].w > sizes[0].h ? fitP : Math.min(fitW, MAX_AUTO_ZOOM);
    return clamp(Math.floor(z * 1000) / 1000 || 1, MIN_ZOOM, MAX_ZOOM);
  }

  rowPages(index) {
    if (this.mode !== 'two-up') return [index];
    const offset = this.cover ? 1 : 0;
    if (this.cover && index === 0) return [0];
    const start = index - ((index - offset) % 2);
    return start + 1 < this.numPages ? [start, start + 1] : [start];
  }

  /**
   * @param {number|string} value  a zoom factor or 'auto' | 'fit-width' | 'fit-page'
   * @param {{x:number,y:number}} [at]  viewport point to keep still (default: centre)
   */
  setZoom(value, at) {
    if (!this.layout) return;
    const anchor = at ? this.captureAnchor(at.x, at.y) : this.centerAnchor();
    this.zoomMode = typeof value === 'number' ? clamp(value, MIN_ZOOM, MAX_ZOOM) : value;
    const z = this.resolveZoom(this.zoomMode);
    if (z === this.zoom && typeof value === typeof this.zoomMode) {
      this.emit('zoomchange');
      return;
    }
    this.zoom = z;
    this.holdRendering();
    this.relayout(anchor);
    this.emit('zoomchange');
  }

  zoomIn(at) {
    const next = ZOOM_LEVELS.find((z) => z > this.zoom * 1.001) ?? MAX_ZOOM;
    this.setZoom(next, at);
  }

  zoomOut(at) {
    const prev = [...ZOOM_LEVELS].reverse().find((z) => z < this.zoom * 0.999) ?? MIN_ZOOM;
    this.setZoom(prev, at);
  }

  /** Delay sharp re-rendering while zoom keeps changing (pinch, wheel). */
  holdRendering() {
    this.holdUntil = performance.now() + RERENDER_DELAY;
    clearTimeout(this.holdTimer);
    this.holdTimer = setTimeout(() => this.update(), RERENDER_DELAY + 10);
  }

  handleWheel(e) {
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    const rect = this.container.getBoundingClientRect();
    const at = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    if (e.deltaMode === 0 && Math.abs(e.deltaY) < 50) {
      // Trackpad pinch (or a fine wheel): smooth, proportional zoom.
      this.setZoom(this.zoom * Math.exp(-e.deltaY / 100), at);
    } else if (e.deltaY < 0) {
      this.zoomIn(at);
    } else if (e.deltaY > 0) {
      this.zoomOut(at);
    }
  }

  bindGestures() {
    // Safari sends gesture events for trackpad pinch.
    let start = 1;
    const point = (e) => {
      const rect = this.container.getBoundingClientRect();
      return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    };
    this.container.addEventListener('gesturestart', (e) => {
      e.preventDefault();
      start = this.zoom;
    });
    this.container.addEventListener('gesturechange', (e) => {
      e.preventDefault();
      this.setZoom(start * e.scale, point(e));
    });
  }

  /** Hidden tabs (display:none) have no size: don't lay out or render. */
  get isHidden() {
    return this.container.clientWidth === 0 && this.container.clientHeight === 0;
  }

  handleResize() {
    if (!this.layout || this.destroyed || this.isHidden) return;
    const anchor = this.captureAnchor(0, 0);
    if (ZOOM_MODES.includes(this.zoomMode)) {
      const z = this.resolveZoom(this.zoomMode);
      if (z !== this.zoom) {
        this.zoom = z;
        this.holdRendering();
        this.relayout(anchor);
        this.emit('zoomchange');
        return;
      }
    }
    this.relayout(anchor);
  }

  // ----------------------------------------------------- layout modes

  setMode(mode, { cover = this.cover } = {}) {
    if (mode === this.mode && cover === this.cover) return;
    const page = this.current;
    this.mode = mode;
    this.cover = cover;
    if (ZOOM_MODES.includes(this.zoomMode)) this.zoom = this.resolveZoom(this.zoomMode);
    this.relayout(null);
    this.goToPage(page + 1);
    this.emit('layoutchange');
    this.emit('zoomchange');
  }

  rotate(delta) {
    const page = this.current;
    const anchor = this.captureAnchor(0, 0);
    this.rotation = (((this.rotation + delta) % 360) + 360) % 360;
    if (ZOOM_MODES.includes(this.zoomMode)) this.zoom = this.resolveZoom(this.zoomMode);
    this.relayout(anchor?.idx === page ? { ...anchor, fx: 0, fy: 0, vx: 0, vy: GAP / 2 } : null);
    if (!anchor) this.goToPage(page + 1);
    this.emit('layoutchange');
    this.emit('zoomchange');
  }

  // -------------------------------------------------------- navigation

  get currentPage() {
    return this.current + 1;
  }

  /**
   * Scroll so page n (1-based) is at the top. fy/fx: point within the page
   * (0–1) to bring into view, e.g. from a link destination.
   */
  goToPage(n, { fy = null, fx = null } = {}) {
    if (!this.layout) return;
    const idx = clamp(Math.round(n) - 1, 0, this.numPages - 1);
    if (this.mode === 'single' && idx !== this.current) {
      this.current = idx;
      this.relayout(null);
    }
    const it = this.layout.items[idx];
    if (!it) return;
    const top = this.content.offsetTop + it.y + (fy === null ? 0 : fy * it.h) - GAP / 2;
    this.container.scrollTop = Math.max(0, top);
    if (fx !== null) this.container.scrollLeft = this.content.offsetLeft + it.x + fx * it.w - GAP;
    this.setCurrent(idx);
    this.update();
  }

  next() {
    const row = this.rowPages(this.current);
    this.goToPage(row.at(-1) + 2);
  }

  prev() {
    const row = this.rowPages(this.current);
    const target = row[0] - 1;
    if (target < 0) return this.goToPage(1);
    this.goToPage(this.rowPages(target)[0] + 1);
  }

  /** Follow a PDF destination (named string or explicit array). */
  async goToDest(dest) {
    let explicit = dest;
    if (typeof dest === 'string') explicit = await this.doc.getDestination(dest);
    if (!Array.isArray(explicit) || this.destroyed) return false;
    const [ref, kind, ...args] = explicit;
    let index = null;
    if (Number.isInteger(ref)) index = ref;
    else if (ref && typeof ref === 'object') index = await this.doc.getPageIndex(ref).catch(() => null);
    if (index === null || index < 0 || index >= this.numPages) return false;

    let fy = null;
    let fx = null;
    const name = kind?.name;
    const top = name === 'XYZ' ? args[1] : name === 'FitH' || name === 'FitBH' ? args[0] : name === 'FitR' ? args[3] : null;
    const left = name === 'XYZ' ? args[0] : name === 'FitR' ? args[0] : null;
    if (typeof top === 'number' || typeof left === 'number') {
      const proxy = await this.getPage(index).catch(() => null);
      if (proxy) {
        const rotation = (proxy.rotate + this.rotation) % 360;
        const vp = proxy.getViewport({ scale: 1, rotation });
        const [px, py] = vp.convertToViewportPoint(left ?? proxy.view[0], top ?? proxy.view[3]);
        if (typeof top === 'number') fy = clamp(py / vp.height, 0, 1);
        if (typeof left === 'number') fx = clamp(px / vp.width, 0, 1);
      }
    }
    this.emit('navigate', { from: this.currentPage, to: index + 1 });
    this.goToPage(index + 1, { fy, fx });
    return true;
  }

  handleClick(e) {
    const link = e.target.closest?.('a.pdf-link');
    if (!link) return;
    e.preventDefault();
    if (link.dataset.url) {
      this.emit('externallink', { url: link.dataset.url });
    } else if (link.dataset.dest) {
      this.goToDest(JSON.parse(link.dataset.dest));
    }
  }

  handleKey(e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.target !== this.container && e.target.closest('input, textarea, select, [contenteditable]')) return;
    const noHScroll = this.container.scrollWidth <= this.container.clientWidth;
    const single = this.mode === 'single';
    let handled = true;
    switch (e.key) {
      case 'Home': this.goToPage(1); break;
      case 'End': this.goToPage(this.numPages); break;
      case 'ArrowRight': if (noHScroll) this.next(); else handled = false; break;
      case 'ArrowLeft': if (noHScroll) this.prev(); else handled = false; break;
      case 'PageDown': if (single) this.next(); else handled = false; break;
      case 'PageUp': if (single) this.prev(); else handled = false; break;
      default: handled = false;
    }
    if (handled) e.preventDefault();
  }

  // ------------------------------------------------- visibility + render

  scheduleUpdate() {
    if (this.raf || this.destroyed) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.update();
    });
  }

  setCurrent(idx) {
    if (idx !== this.current) {
      this.current = idx;
      this.emit('pagechange');
    }
  }

  /** Recompute what's visible, the current page, and what to render. */
  update() {
    if (!this.layout || this.destroyed || this.isHidden) return;
    const left = this.container.scrollLeft - this.content.offsetLeft;
    const top = this.container.scrollTop - this.content.offsetTop;
    const vw = this.container.clientWidth;
    const vh = this.container.clientHeight;
    const rows = visibleRows(this.layout, top, top + vh);
    const visible = [];
    let best = -1;
    let bestArea = -1;
    for (const row of rows) {
      for (const i of row.pages) {
        const it = this.layout.items[i];
        const x0 = Math.max(left, it.x);
        const y0 = Math.max(top, it.y);
        const x1 = Math.min(left + vw, it.x + it.w);
        const y1 = Math.min(top + vh, it.y + it.h);
        if (x1 <= x0 || y1 <= y0) continue;
        const rect = { x: x0 - it.x, y: y0 - it.y, w: x1 - x0, h: y1 - y0 };
        visible.push({ i, rect });
        if (rect.w * rect.h > bestArea) {
          bestArea = rect.w * rect.h;
          best = i;
        }
      }
    }
    if (this.mode !== 'single' && best >= 0) this.setCurrent(best);
    this.visible = visible.map((v) => v.i);

    if (performance.now() < this.holdUntil) return; // zooming: wait, then render sharp
    this.schedule(visible);
  }

  renderParams() {
    return {
      zoom: this.zoom,
      scale: this.layout.scale,
      rotation: this.rotation,
      dpr: Math.min(window.devicePixelRatio || 1, 4),
    };
  }

  schedule(visible) {
    const params = this.renderParams();
    this.params = params;
    const key = `${params.scale}|${params.rotation}|${params.dpr}`;
    if (!visible.length) {
      visible = this.layout.items[this.current] ? [{ i: this.current, rect: null }] : [];
    }
    const lo = Math.min(...visible.map((v) => v.i));
    const hi = Math.max(...visible.map((v) => v.i));

    // Release pages far from view; cancel renders that are out of date.
    this.views.forEach((v, i) => {
      const far = i < lo - KEEP || i > hi + KEEP || !this.layout.items[i];
      if (far && (v.hasContent || v.busy)) v.release();
      else if (v.busy && v.runKey !== key) v.cancel();
    });

    const queue = visible.map((v) => ({ view: this.views[v.i], rect: v.rect }));
    for (let d = 1; d <= PREFETCH; d++) {
      for (const i of [hi + d, lo - d]) {
        if (i >= 0 && i < this.numPages && this.layout.items[i]) queue.push({ view: this.views[i], rect: null });
      }
    }
    this.queue = queue;
    this.pump(key);
  }

  pump(key) {
    while (this.running < MAX_CONCURRENT && this.queue.length) {
      const { view, rect } = this.queue.shift();
      if (view.busy) continue;
      const item = this.layout.items[view.index];
      if (!view.prepare(this.params, item, rect)) continue;
      view.busy = true;
      view.runKey = key;
      this.running++;
      view.run(this.params).finally(() => {
        view.busy = false;
        this.running--;
        if (this.destroyed) return;
        this.emit('rendered', { page: view.index + 1 });
        this.scheduleUpdate();
      });
    }
  }

  // ------------------------------------------------------------- misc

  emit(type, detail = {}) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  /** Snapshot of the view state (used by the UI and tests). */
  get state() {
    return {
      page: this.currentPage,
      numPages: this.numPages,
      zoom: this.zoom,
      zoomMode: this.zoomMode,
      mode: this.mode,
      cover: this.cover,
      rotation: this.rotation,
      visible: (this.visible ?? []).map((i) => i + 1),
    };
  }

  focus() {
    this.container.focus({ preventScroll: true });
  }

  destroy() {
    this.destroyed = true;
    cancelAnimationFrame(this.raf);
    clearTimeout(this.holdTimer);
    this.resizeObserver.disconnect();
    for (const v of this.views) v.release();
    this.container.remove();
  }
}
