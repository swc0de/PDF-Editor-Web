// One page slot in the viewer: placeholder → canvas (or tiles when zoomed in
// far) + text layer + link layer, or an error tile when the page is broken.
import { h } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { t } from '../i18n/index.js';
import { FormLayer } from './form-layer.js';

/** Above this zoom, pages are drawn as tiles (only the visible ones). */
export const TILE_ZOOM = 3;
/** Tile edge in device pixels. */
export const TILE_SIZE = 1024;
/** A single canvas above this many device pixels is drawn as tiles too. */
export const MAX_CANVAS_PIXELS = 16_777_216;
/** Pixel budget for the low-resolution backdrop shown under tiles. */
const BASE_PIXELS = 4_000_000;
const MAX_TILES_PER_PAGE = 48;

/** Annotation subtypes listed as comments (Links, widgets and popups aren't). */
export const MARKUP = new Set(['Text', 'FreeText', 'Line', 'Square', 'Circle', 'Polygon', 'PolyLine', 'Highlight',
  'Underline', 'Squiggly', 'StrikeOut', 'Stamp', 'Caret', 'Ink', 'FileAttachment', 'Sound', 'Redact']);

const isCancel = (err) => err?.name === 'RenderingCancelledException' || err?.name === 'AbortException';

export class PageView {
  /**
   * @param {number} index
   * @param {object} deps
   * @param {object} deps.pdfjs           the pdf.js module
   * @param {(i:number) => Promise<object>} deps.getPage
   */
  constructor(index, { pdfjs, getPage, getOcConfig, onTextLayer, onAnnotations, forms }) {
    this.index = index;
    this.pdfjs = pdfjs;
    this.getPage = getPage;
    this.getOcConfig = getOcConfig;
    this.onTextLayer = onTextLayer;
    this.onAnnotations = onAnnotations;
    this.forms = forms ?? null; // { scope, onCommit, onSign, onTabOut, isReadOnly } → FormLayer
    this.formLayer = null;
    this.widgets = null; // widget annotations (pdf.js data) once loaded
    this.annotationCanvases = null; // checkbox/radio/button appearances from the last full render
    this.annotations = null; // markup annotations (pdf.js data) once loaded
    this.textLayerObj = null; // the pdf.js TextLayer (textDivs ↔ text items)
    this.proxy = null;
    this.error = null;
    this.generation = 0;
    this.busy = false;
    this.task = null;
    this.plan = [];

    this.canvas = null; // full-page canvas (or the low-res backdrop in tiled mode)
    this.canvasKey = null;
    this.tiles = new Map(); // "col,row" → canvas
    this.tileKey = null;
    this.textLayer = null;
    this.textRotation = null;
    this.linkLayer = null;
    this.linkRotation = null;

    this.placeholder = h('span.page-placeholder', { 'aria-hidden': 'true' }, String(index + 1));
    this.tileLayer = h('div.tile-layer');
    this.el = h(
      'div.page',
      {
        role: 'region',
        'aria-label': t('viewer.pageLabel', { n: index + 1 }),
        dataset: { pageNumber: String(index + 1), state: 'placeholder' },
      },
      this.placeholder,
      this.tileLayer,
    );
  }

  setLayout(item, scale) {
    const s = this.el.style;
    if (!item) {
      this.el.hidden = true;
      return;
    }
    this.el.hidden = false;
    s.left = `${item.x}px`;
    s.top = `${item.y}px`;
    s.width = `${item.w}px`;
    s.height = `${item.h}px`;
    s.setProperty('--scale-factor', String(scale));
  }

  /** pdf.js viewport rotation is absolute: the page's own /Rotate plus the view's. */
  rot(params) {
    return ((this.proxy?.rotate ?? 0) + params.rotation) % 360;
  }

  setProxy(proxy) {
    this.proxy = proxy;
    this.el.style.setProperty('--user-unit', String(proxy.userUnit ?? 1));
  }

  setError(err) {
    if (this.error) return;
    this.error = err ?? new Error('unknown error');
    this.release();
    this.el.dataset.state = 'error';
    this.placeholder.remove();
    this.el.append(
      h(
        'div.page-error',
        { role: 'alert' },
        icon('alertTriangle', { size: 22 }),
        h('strong', t('viewer.pageError.title', { n: this.index + 1 })),
        h('span', t('viewer.pageError.detail')),
      ),
    );
  }

  /** Is the full-page canvas too big, or the zoom too high, for one canvas? */
  static isTiled(params, item) {
    return params.zoom > TILE_ZOOM || item.w * item.h * params.dpr * params.dpr > MAX_CANVAS_PIXELS;
  }

  /**
   * Work out what this page still needs for the given render parameters.
   * @param {{zoom:number, scale:number, rotation:number, dpr:number}} params
   * @param {{x:number,y:number,w:number,h:number}} item    layout box
   * @param {{x:number,y:number,w:number,h:number}|null} visible  page-local CSS rect
   */
  prepare(params, item, visible) {
    this.plan = [];
    if (this.error || !item) return false;
    const key = `${params.scale.toFixed(5)}|${params.rotation}|${params.dpr}`;
    if (PageView.isTiled(params, item)) {
      if (!this.canvas) this.plan.push({ type: 'base' });
      if (this.tileKey !== key) this.clearTiles();
      if (visible) {
        for (const tile of this.tilesFor(params, item, visible)) {
          if (!this.tiles.has(tile.id)) this.plan.push({ type: 'tile', tile, key });
        }
      }
    } else {
      if (this.tiles.size) this.clearTiles();
      if (this.canvasKey !== key) this.plan.push({ type: 'full', key });
    }
    if (this.textRotation !== params.rotation) this.plan.push({ type: 'text' });
    if (this.linkRotation !== params.rotation) this.plan.push({ type: 'links' });
    return this.plan.length > 0;
  }

  /** Visible tiles (plus a margin) in tile-grid coordinates. */
  tilesFor(params, item, visible) {
    const dpr = params.dpr;
    const fullW = Math.ceil(item.w * dpr);
    const fullH = Math.ceil(item.h * dpr);
    const margin = TILE_SIZE / dpr / 2;
    const x0 = Math.max(0, (visible.x - margin) * dpr);
    const y0 = Math.max(0, (visible.y - margin) * dpr);
    const x1 = Math.min(fullW, (visible.x + visible.w + margin) * dpr);
    const y1 = Math.min(fullH, (visible.y + visible.h + margin) * dpr);
    const out = [];
    for (let r = Math.floor(y0 / TILE_SIZE); r * TILE_SIZE < y1; r++) {
      for (let c = Math.floor(x0 / TILE_SIZE); c * TILE_SIZE < x1; c++) {
        out.push({
          id: `${c},${r}`,
          x: c * TILE_SIZE,
          y: r * TILE_SIZE,
          w: Math.min(TILE_SIZE, fullW - c * TILE_SIZE),
          h: Math.min(TILE_SIZE, fullH - r * TILE_SIZE),
        });
      }
    }
    // Drop tiles that have scrolled well out of view.
    const keep = new Set(out.map((tile) => tile.id));
    if (this.tiles.size > MAX_TILES_PER_PAGE) {
      for (const [id, canvas] of this.tiles) {
        if (!keep.has(id)) {
          releaseCanvas(canvas);
          this.tiles.delete(id);
        }
      }
    }
    return out;
  }

  /** Execute the plan made by prepare(). Resolves when done or cancelled. */
  async run(params) {
    const gen = this.generation;
    const stale = () => gen !== this.generation;
    try {
      if (!this.proxy) this.setProxy(await this.getPage(this.index));
      if (stale()) return;
      for (const job of this.plan) {
        if (stale()) return;
        if (job.type === 'full') await this.renderFull(params, job.key, stale);
        else if (job.type === 'base') await this.renderBase(params, stale);
        else if (job.type === 'tile') await this.renderTile(params, job, stale);
        else if (job.type === 'text') await this.renderText(params, stale);
        else if (job.type === 'links') await this.renderLinks(params, stale);
      }
    } catch (err) {
      if (isCancel(err) || stale()) return;
      this.setError(err);
    }
  }

  async draw(canvas, viewport, transform, stale, annotationCanvasMap = new Map()) {
    const oc = (await this.getOcConfig?.()) ?? null;
    if (stale()) return false;
    this.task = this.proxy.render({
      canvas,
      viewport,
      transform,
      // Forms mode: widgets are drawn by the HTML form layer; checkbox, radio
      // and push-button appearances land in annotationCanvasMap (a throwaway
      // map for tiles, so they're never baked into the page canvas).
      annotationMode: this.pdfjs.AnnotationMode.ENABLE_FORMS,
      annotationCanvasMap,
      optionalContentConfigPromise: oc ? Promise.resolve(oc) : undefined,
    });
    try {
      await this.task.promise;
    } finally {
      this.task = null;
    }
    return !stale();
  }

  async renderFull(params, key, stale) {
    const viewport = this.proxy.getViewport({ scale: params.scale, rotation: this.rot(params) });
    const canvas = h('canvas.page-canvas', { 'aria-hidden': 'true' });
    canvas.width = Math.max(1, Math.floor(viewport.width * params.dpr));
    canvas.height = Math.max(1, Math.floor(viewport.height * params.dpr));
    const transform = params.dpr !== 1 ? [params.dpr, 0, 0, params.dpr, 0, 0] : undefined;
    const canvases = new Map();
    if (!(await this.draw(canvas, viewport, transform, stale, canvases))) return releaseCanvas(canvas);
    this.swapCanvas(canvas, key);
    this.setAnnotationCanvases(canvases);
  }

  async renderBase(params, stale) {
    const vp1 = this.proxy.getViewport({ scale: 1, rotation: this.rot(params) });
    const scale = Math.min(params.scale * params.dpr, Math.sqrt(BASE_PIXELS / (vp1.width * vp1.height)));
    const viewport = this.proxy.getViewport({ scale, rotation: this.rot(params) });
    const canvas = h('canvas.page-canvas', { 'aria-hidden': 'true' });
    canvas.width = Math.max(1, Math.floor(viewport.width));
    canvas.height = Math.max(1, Math.floor(viewport.height));
    const canvases = new Map();
    if (!(await this.draw(canvas, viewport, undefined, stale, canvases))) return releaseCanvas(canvas);
    this.swapCanvas(canvas, 'base');
    this.setAnnotationCanvases(canvases);
  }

  async renderTile(params, { tile, key }, stale) {
    const viewport = this.proxy.getViewport({ scale: params.scale * params.dpr, rotation: this.rot(params) });
    const canvas = h('canvas.tile', { 'aria-hidden': 'true' });
    canvas.width = tile.w;
    canvas.height = tile.h;
    Object.assign(canvas.style, {
      left: `${tile.x / params.dpr}px`,
      top: `${tile.y / params.dpr}px`,
      width: `${tile.w / params.dpr}px`,
      height: `${tile.h / params.dpr}px`,
    });
    if (!(await this.draw(canvas, viewport, [1, 0, 0, 1, -tile.x, -tile.y], stale))) {
      return releaseCanvas(canvas);
    }
    this.tileKey = key;
    this.tiles.get(tile.id)?.remove();
    this.tiles.set(tile.id, canvas);
    this.tileLayer.append(canvas);
    this.markRendered();
  }

  setAnnotationCanvases(map) {
    this.annotationCanvases = map;
    this.formLayer?.setCanvases(map);
  }

  swapCanvas(canvas, key) {
    if (this.canvas) releaseCanvas(this.canvas);
    this.canvas = canvas;
    this.canvasKey = key;
    this.el.insertBefore(canvas, this.tileLayer);
    this.markRendered();
  }

  markRendered() {
    this.placeholder.hidden = true;
    this.el.dataset.state = 'rendered';
  }

  async renderText(params, stale) {
    const viewport = this.proxy.getViewport({ scale: params.scale, rotation: this.rot(params) });
    const div = h('div.textLayer');
    const layer = new this.pdfjs.TextLayer({
      textContentSource: this.proxy.streamTextContent({ includeMarkedContent: true, disableNormalization: true }),
      container: div,
      viewport,
    });
    await layer.render();
    if (stale()) return;
    // An end-of-content marker keeps drag-selection from jumping (as in pdf.js).
    const end = h('div.endOfContent');
    div.append(end);
    div.addEventListener('mousedown', () => {
      div.classList.add('selecting');
      const up = () => {
        div.classList.remove('selecting');
        document.removeEventListener('mouseup', up);
      };
      document.addEventListener('mouseup', up);
    });
    this.textLayer?.remove();
    this.textLayer = div;
    this.textLayerObj = layer;
    this.textRotation = params.rotation;
    this.el.append(div);
    this.onTextLayer?.(this);
  }

  async renderLinks(params, stale) {
    const proxy = this.proxy;
    const annotations = await proxy.getAnnotations({ intent: 'display' });
    if (stale() || proxy !== this.proxy) return;
    const viewport = proxy.getViewport({ scale: params.scale, rotation: this.rot(params) });
    // Kept for converting pointer positions ↔ PDF coordinates (annotation tools).
    this.baseViewport = proxy.getViewport({ scale: 1, rotation: this.rot(params) });
    const div = h('div.linkLayer');
    this.pdfjs.setLayerDimensions(div, viewport);
    const [vx0, , vx1, vy1] = proxy.view;
    const W = vx1 - vx0;
    const H = vy1 - proxy.view[1];
    for (const a of annotations) {
      if (a.subtype !== 'Link') continue;
      const url = a.url ?? null;
      const dest = a.dest ?? null;
      if (!url && !dest) continue;
      const [x0, y0, x1, y1] = this.pdfjs.Util.normalizeRect(a.rect);
      const link = h('a.pdf-link', {
        href: url ?? '#',
        title: url ?? t('viewer.link.internal'),
        rel: 'noopener noreferrer',
        dataset: url ? { url } : { dest: JSON.stringify(dest) },
      });
      Object.assign(link.style, {
        left: `${((x0 - vx0) / W) * 100}%`,
        top: `${((vy1 - y1) / H) * 100}%`,
        width: `${((x1 - x0) / W) * 100}%`,
        height: `${((y1 - y0) / H) * 100}%`,
      });
      div.append(link);
    }
    // Comments/markup: hit areas the annotation tools work with (and a
    // visible icon for notes that have no appearance of their own).
    const markup = annotations.filter((a) => MARKUP.has(a.subtype) && !a.inReplyTo && !(a.annotationFlags & 2));
    for (const a of markup) {
      const [x0, y0, x1, y1] = this.pdfjs.Util.normalizeRect(a.rect);
      const box = h('div.annot-box', {
        dataset: { annotId: a.id, subtype: a.subtype },
        title: [a.titleObj?.str, a.contentsObj?.str].filter(Boolean).join(': ') || null,
      });
      if (a.subtype === 'Text' && !a.hasAppearance) box.classList.add('note-icon');
      Object.assign(box.style, {
        left: `${((x0 - vx0) / W) * 100}%`,
        top: `${((vy1 - y1) / H) * 100}%`,
        width: `${((x1 - x0) / W) * 100}%`,
        height: `${((y1 - y0) / H) * 100}%`,
      });
      div.append(box);
    }
    this.annotations = markup;
    this.linkLayer?.remove();
    this.linkLayer = div;
    this.linkRotation = params.rotation;
    this.el.append(div);
    // Form fields: HTML controls, updated in place across document reloads.
    const widgets = annotations.filter((a) => a.subtype === 'Widget');
    this.widgets = widgets;
    if (this.forms && (widgets.length || this.formLayer)) {
      if (!this.formLayer) {
        this.formLayer = new FormLayer({ ...this.forms, scope: `${this.forms.scope}-p${this.index}` });
        if (this.annotationCanvases) this.formLayer.setCanvases(this.annotationCanvases);
      }
      this.formLayer.render(widgets, proxy.view, this.pdfjs, viewport);
      // Re-appending a node that holds focus would blur it.
      if (this.formLayer.el.parentNode !== this.el) this.el.append(this.formLayer.el);
    }
    this.onAnnotations?.(this);
  }

  clearTiles() {
    for (const canvas of this.tiles.values()) releaseCanvas(canvas);
    this.tiles.clear();
    this.tileKey = null;
  }

  /** Draw again on the next update (e.g. layers changed); the old canvas stays until then. */
  invalidate() {
    this.cancel();
    this.canvasKey = null;
    this.clearTiles();
  }

  /** Forget everything about this page (its content changed). The form layer stays, to be updated in place. */
  reset() {
    this.release({ keepForm: true });
    this.proxy = null;
    if (this.error) {
      this.error = null;
      this.el.querySelector('.page-error')?.remove();
      this.el.prepend(this.placeholder);
      this.placeholder.hidden = false;
      this.el.dataset.state = 'placeholder';
    }
  }

  /** Stop any in-flight render. */
  cancel() {
    this.generation++;
    this.task?.cancel();
    this.task = null;
  }

  /** Free canvases and layers (the placeholder stays, at the right size). */
  release({ keepForm = false } = {}) {
    this.cancel();
    if (!keepForm) {
      this.formLayer?.el.remove();
      this.formLayer = null;
      this.annotationCanvases = null;
    }
    this.widgets = null;
    if (this.canvas) releaseCanvas(this.canvas);
    this.canvas = null;
    this.canvasKey = null;
    this.clearTiles();
    this.textLayer?.remove();
    this.textLayer = null;
    this.textLayerObj = null;
    this.textRotation = null;
    this.linkLayer?.remove();
    this.linkLayer = null;
    this.linkRotation = null;
    this.annotations = null;
    if (!this.error) {
      this.placeholder.hidden = false;
      this.el.dataset.state = 'placeholder';
    }
  }

  get hasContent() {
    return !!(this.canvas || this.tiles.size || this.textLayer);
  }
}

/** Shrinking a canvas to 0×0 frees its backing store right away. */
function releaseCanvas(canvas) {
  canvas.width = 0;
  canvas.height = 0;
  canvas.remove();
}
