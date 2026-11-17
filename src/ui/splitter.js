// A draggable, keyboard-accessible resize handle for side panels.
import { h } from './dom.js';

/**
 * @param {object} o
 * @param {string} o.label                 accessible name
 * @param {() => number} o.get             current width
 * @param {(w:number) => void} o.set       apply a width (live)
 * @param {(w:number) => void} o.commit    persist when done
 * @param {{min:number,max:number}} o.range
 * @param {() => 1|-1} o.direction         +1: dragging right grows the panel
 */
export function createSplitter({ label, get, set, commit, range, direction }) {
  const el = h('div.splitter', {
    role: 'separator',
    tabindex: '0',
    'aria-orientation': 'vertical',
    'aria-label': label,
    'aria-valuemin': String(range.min),
    'aria-valuemax': String(range.max),
  });
  const clamp = (w) => Math.round(Math.min(range.max, Math.max(range.min, w)));
  const sync = () => el.setAttribute('aria-valuenow', String(Math.round(get())));

  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startW = get();
    el.classList.add('dragging');
    document.documentElement.classList.add('resizing');
    const move = (ev) => {
      set(clamp(startW + (ev.clientX - startX) * direction()));
      sync();
    };
    const up = () => {
      el.classList.remove('dragging');
      document.documentElement.classList.remove('resizing');
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      commit(get());
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  });

  el.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 64 : 16;
    let w = null;
    if (e.key === 'ArrowLeft') w = get() - step * direction();
    else if (e.key === 'ArrowRight') w = get() + step * direction();
    else if (e.key === 'Home') w = range.min;
    else if (e.key === 'End') w = range.max;
    if (w === null) return;
    e.preventDefault();
    set(clamp(w));
    sync();
    commit(get());
  });

  sync();
  return { el, sync };
}
