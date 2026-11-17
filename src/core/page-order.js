// Pure helpers for reordering pages.

/**
 * Move the `selected` pages (0-based, any order) so they land, in their
 * current relative order, at insertion point `target` — an index in the
 * *original* order (0 = before the first page, count = after the last).
 * @returns {{ order: number[], selection: number[], changed: boolean }}
 *   order[k] = old index of the page now at position k
 */
export function moveSelection(count, selected, target) {
  const sel = [...new Set(selected)].filter((i) => i >= 0 && i < count).sort((a, b) => a - b);
  const set = new Set(sel);
  const rest = [];
  for (let i = 0; i < count; i++) if (!set.has(i)) rest.push(i);
  const clamped = Math.max(0, Math.min(count, target));
  const pos = rest.filter((i) => i < clamped).length;
  const order = [...rest.slice(0, pos), ...sel, ...rest.slice(pos)];
  const changed = order.some((old, k) => old !== k);
  return { order, selection: sel.map((_, k) => pos + k), changed };
}

/** Move the selection one step left (-1) or right (+1). */
export function nudgeSelection(count, selected, dir) {
  const sel = [...new Set(selected)].sort((a, b) => a - b);
  if (!sel.length) return { order: [...Array(count).keys()], selection: [], changed: false };
  const target = dir < 0 ? sel[0] - 1 : sel.at(-1) + 2;
  return moveSelection(count, sel, target);
}
