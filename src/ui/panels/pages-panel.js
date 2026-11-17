// Pages panel: lazy page thumbnails (IntersectionObserver), a size slider,
// the current page highlighted, click to jump.
import { h } from '../dom.js';
import { icon } from '../icons.js';
import { t } from '../../i18n/index.js';
import { implementPanel } from '../panels.js';
import { getPref, setPref } from '../../core/prefs.js';
import { rotatedSize } from '../../view/layout.js';

const BASE_WIDTH = 120; // CSS px at 100%
const RENDER_WIDTH = 180; // render once at the 150% size; smaller sizes scale down
const SIZE = { min: 50, max: 150, step: 10, default: 100 };

/** Per-tab cache of rendered thumbnails: page index → object URL. */
function thumbCache(tab) {
  if (!tab.thumbs) {
    tab.thumbs = new Map();
    tab.addEventListener('destroy', () => {
      for (const url of tab.thumbs.values()) URL.revokeObjectURL(url);
      tab.thumbs.clear();
    });
  }
  return tab.thumbs;
}

async function renderThumb(tab, index) {
  const page = await tab.pdf.getPage(index + 1);
  const rotation = (page.rotate + tab.viewer.rotation) % 360;
  const vp1 = page.getViewport({ scale: 1, rotation });
  const scale = (RENDER_WIDTH * Math.min(2, window.devicePixelRatio || 1)) / vp1.width;
  const viewport = page.getViewport({ scale, rotation });
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(viewport.width));
  canvas.height = Math.max(1, Math.round(viewport.height));
  await page.render({ canvas, viewport }).promise;
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  canvas.width = 0;
  canvas.height = 0;
  return blob ? URL.createObjectURL(blob) : null;
}

export function registerPagesPanel() {
  implementPanel('pages', {
    render(container, tab) {
      const viewer = tab.viewer;
      const cache = thumbCache(tab);
      let size = getPref('thumbSize', SIZE.default);
      let disposed = false;

      const slider = h('input.thumb-size', {
        type: 'range',
        min: String(SIZE.min),
        max: String(SIZE.max),
        step: String(SIZE.step),
        value: String(size),
        'aria-label': t('pages.size'),
        title: t('pages.size'),
      });
      const sizeText = h('span.thumb-size-value', `${size}%`);
      const grid = h('div.thumb-grid', { role: 'listbox', 'aria-label': t('panel.pages.label'), 'aria-orientation': 'vertical' });
      const scroller = h('div.thumb-scroller', grid);
      container.append(
        h('div.panel-toolbar', icon('grid', { size: 14 }), slider, sizeText),
        scroller,
      );

      const items = Array.from({ length: viewer.numPages }, (_, i) => {
        const frame = h('div.thumb-frame');
        const el = h('div.thumb', {
          role: 'option',
          tabindex: '-1',
          'aria-selected': 'false',
          'aria-label': t('pages.thumbLabel', { label: viewer.pageLabel(i), n: i + 1 }),
          dataset: { page: String(i + 1) },
        }, frame, h('span.thumb-label', viewer.pageLabel(i)));
        return { el, frame, index: i, state: 'empty' };
      });
      grid.append(...items.map((it) => it.el));

      function applySize() {
        grid.style.setProperty('--thumb-w', `${(BASE_WIDTH * size) / 100}px`);
        for (const it of items) {
          const s = rotatedSize(viewer.sizes[it.index], viewer.rotation);
          it.frame.style.aspectRatio = `${s.w} / ${s.h}`;
        }
      }

      // ---- lazy rendering, one thumbnail at a time
      const queue = new Set();
      let busy = false;
      async function pump() {
        if (busy || disposed) return;
        const it = [...queue][0];
        if (!it) return;
        queue.delete(it);
        busy = true;
        try {
          let url = cache.get(it.index);
          if (!url) {
            url = await renderThumb(tab, it.index);
            if (url) cache.set(it.index, url);
          }
          if (!disposed && url) show(it, url);
        } catch {
          if (!disposed) {
            it.state = 'error';
            it.frame.replaceChildren(icon('alertTriangle', { size: 18 }));
            it.el.dataset.state = 'error';
          }
        } finally {
          busy = false;
          pump();
        }
      }
      function show(it, url) {
        it.state = 'done';
        it.el.dataset.state = 'rendered';
        it.frame.replaceChildren(h('img', { src: url, alt: '', draggable: false }));
      }

      const observer = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          const it = items[Number(entry.target.dataset.page) - 1];
          if (entry.isIntersecting) {
            if (it.state !== 'empty') continue;
            const cached = cache.get(it.index);
            if (cached) show(it, cached);
            else queue.add(it);
          } else {
            queue.delete(it);
          }
        }
        pump();
      }, { root: scroller, rootMargin: '300px 0px' });
      items.forEach((it) => observer.observe(it.el));

      // ---- current page + navigation
      let currentEl = null;
      function syncCurrent({ scroll = true } = {}) {
        const it = items[viewer.current];
        if (!it || it.el === currentEl) return;
        if (currentEl) {
          currentEl.setAttribute('aria-selected', 'false');
          currentEl.tabIndex = -1;
        }
        currentEl = it.el;
        currentEl.setAttribute('aria-selected', 'true');
        currentEl.tabIndex = 0;
        if (scroll) currentEl.scrollIntoView({ block: 'nearest' });
      }
      grid.addEventListener('click', (e) => {
        const el = e.target.closest('.thumb');
        if (!el) return;
        viewer.navigate(Number(el.dataset.page));
        el.focus();
      });
      grid.addEventListener('keydown', (e) => {
        const el = e.target.closest('.thumb');
        if (!el) return;
        const n = Number(el.dataset.page);
        const perRow = Math.max(1, Math.round(grid.clientWidth / (el.offsetWidth + 8)));
        const moves = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: perRow, ArrowUp: -perRow, Home: -Infinity, End: Infinity };
        if (e.key in moves) {
          e.preventDefault();
          const target = Math.min(viewer.numPages, Math.max(1, n + moves[e.key]));
          viewer.navigate(target);
          items[target - 1].el.focus();
        } else if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          viewer.navigate(n);
        }
      });

      slider.addEventListener('input', () => {
        size = Number(slider.value);
        sizeText.textContent = `${size}%`;
        setPref('thumbSize', size);
        applySize();
        currentEl?.scrollIntoView({ block: 'nearest' });
      });

      const onPage = () => syncCurrent();
      let lastRotation = viewer.rotation;
      const onLayout = () => {
        if (viewer.rotation === lastRotation) return;
        lastRotation = viewer.rotation;
        // Rotation changes thumbnails: drop the cache and re-render.
        for (const url of cache.values()) URL.revokeObjectURL(url);
        cache.clear();
        for (const it of items) {
          it.state = 'empty';
          it.frame.replaceChildren();
          delete it.el.dataset.state;
          observer.unobserve(it.el);
          observer.observe(it.el);
        }
        applySize();
      };
      const onSizes = () => applySize();
      viewer.addEventListener('pagechange', onPage);
      viewer.addEventListener('layoutchange', onLayout);
      viewer.addEventListener('sizesloaded', onSizes);

      applySize();
      syncCurrent({ scroll: false });
      requestAnimationFrame(() => currentEl?.scrollIntoView({ block: 'nearest' }));

      return () => {
        disposed = true;
        observer.disconnect();
        viewer.removeEventListener('pagechange', onPage);
        viewer.removeEventListener('layoutchange', onLayout);
        viewer.removeEventListener('sizesloaded', onSizes);
      };
    },
  });
}
