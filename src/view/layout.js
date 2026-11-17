// Pure page-layout maths (no DOM). Given every page's size, a zoom and a
// layout mode, compute where each page sits in the scrollable content.

/** CSS pixels per PDF point at 100% zoom (PDF is 72 dpi, CSS is 96 dpi). */
export const CSS_UNITS = 96 / 72;

export const MODES = ['continuous', 'single', 'two-up'];

/** Displayed (rotated) size of a page in PDF points. */
export function rotatedSize(size, viewRotation) {
  const turn = ((size.rotate ?? 0) + viewRotation) % 180 !== 0;
  return turn ? { w: size.h, h: size.w } : { w: size.w, h: size.h };
}

/** Group page indexes into rows for a mode. */
export function rowsFor(count, mode, { cover = false, current = 0 } = {}) {
  if (mode === 'single') return [[Math.min(Math.max(current, 0), count - 1)]];
  if (mode !== 'two-up') return Array.from({ length: count }, (_, i) => [i]);
  const rows = [];
  let i = 0;
  if (cover && count > 0) rows.push([i++]);
  for (; i < count; i += 2) rows.push(i + 1 < count ? [i, i + 1] : [i]);
  return rows;
}

/**
 * @param {{w:number,h:number,rotate:number}[]} sizes  page sizes in points
 * @param {object} o
 * @param {number} o.zoom        1 = 100%
 * @param {number} o.rotation    view rotation: 0, 90, 180, 270
 * @param {string} o.mode        continuous | single | two-up
 * @param {boolean} o.cover      two-up: show the first page on its own
 * @param {number} o.current     single: the page shown
 * @param {number} o.gap         CSS px between pages and around the edges
 */
export function computeLayout(sizes, { zoom, rotation = 0, mode = 'continuous', cover = false, current = 0, gap = 16 }) {
  const scale = zoom * CSS_UNITS;
  const items = sizes.map(() => null); // pages not in the layout (single mode) stay null
  const rows = [];
  let y = gap;
  let maxRowWidth = 0;

  for (const pages of rowsFor(sizes.length, mode, { cover, current })) {
    const dims = pages.map((i) => {
      const s = rotatedSize(sizes[i], rotation);
      return { i, w: Math.round(s.w * scale), h: Math.round(s.h * scale) };
    });
    const rowWidth = dims.reduce((sum, d) => sum + d.w, 0) + gap * (dims.length - 1);
    const rowHeight = Math.max(...dims.map((d) => d.h));
    rows.push({ y, h: rowHeight, w: rowWidth, pages, dims });
    maxRowWidth = Math.max(maxRowWidth, rowWidth);
    y += rowHeight + gap;
  }

  const width = maxRowWidth + gap * 2;
  for (const row of rows) {
    let x = Math.round((width - row.w) / 2);
    for (const d of row.dims) {
      // Pages in a row are vertically centred against the tallest one.
      items[d.i] = { x, y: row.y + Math.round((row.h - d.h) / 2), w: d.w, h: d.h };
      x += d.w + gap;
    }
    delete row.dims;
  }
  return { width, height: y, rows, items, scale, gap };
}

/** Rows that intersect [top, bottom] (content coordinates), by binary search. */
export function visibleRows(layout, top, bottom) {
  const { rows } = layout;
  let lo = 0;
  let hi = rows.length - 1;
  let first = rows.length;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (rows[mid].y + rows[mid].h >= top) {
      first = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  const out = [];
  for (let r = first; r < rows.length && rows[r].y <= bottom; r++) out.push(rows[r]);
  return out;
}

/** The page under a content-space point, or the nearest one vertically. */
export function pageAtPoint(layout, x, y) {
  let best = -1;
  let bestDist = Infinity;
  layout.items.forEach((it, i) => {
    if (!it) return;
    const dx = x < it.x ? it.x - x : x > it.x + it.w ? x - it.x - it.w : 0;
    const dy = y < it.y ? it.y - y : y > it.y + it.h ? y - it.y - it.h : 0;
    const dist = dy * 4 + dx; // prefer the right row over the right column
    if (dist < bestDist) {
      bestDist = dist;
      best = i;
    }
  });
  return best;
}
