// Page range strings: "1-3, 7, 10-" → 0-based indexes.

/**
 * @param {string} text   e.g. "1-3, 7, 10-", "-4", "all", "" (= all)
 * @param {number} count  number of pages
 * @returns {{ pages: number[] } | { error: string }}  pages in the given order, deduplicated
 */
export function parsePageRange(text, count) {
  const value = String(text ?? '').trim().toLowerCase();
  if (!value || value === 'all') return { pages: [...Array(count).keys()] };
  const out = [];
  const seen = new Set();
  for (const raw of value.split(/[,;\s]+/).filter(Boolean)) {
    const m = raw.match(/^(\d*)\s*-\s*(\d*)$|^(\d+)$/);
    if (!m) return { error: raw };
    let from;
    let to;
    if (m[3]) {
      from = to = Number(m[3]);
    } else {
      from = m[1] ? Number(m[1]) : 1;
      to = m[2] ? Number(m[2]) : count;
    }
    if (from < 1 || to < 1 || from > count || to > count) return { error: raw };
    const step = from <= to ? 1 : -1;
    for (let p = from; step > 0 ? p <= to : p >= to; p += step) {
      if (!seen.has(p)) {
        seen.add(p);
        out.push(p - 1);
      }
    }
  }
  return out.length ? { pages: out } : { error: value };
}

/** 0-based indexes → compact "1-3, 7" text. */
export function formatPageRange(pages) {
  const sorted = [...new Set(pages)].sort((a, b) => a - b);
  const parts = [];
  for (let i = 0; i < sorted.length; i++) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
    parts.push(i === j ? `${sorted[i] + 1}` : `${sorted[i] + 1}-${sorted[j] + 1}`);
    i = j;
  }
  return parts.join(', ');
}
