// Work out the parts of a split (pure; the job does the copying).
import { formatPageRange } from './page-range.js';

const pad = (n, width) => String(n).padStart(width, '0');

/** "Chapter 2: Results?" → "chapter-2-results" */
export function slug(text, max = 40) {
  const s = String(text)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/, '');
  return s || 'part';
}

/**
 * @param {object} o
 * @param {number} o.count            pages in the document
 * @param {string} o.base             file name without .pdf
 * @param {'every'|'at'|'bookmarks'} o.mode
 * @param {number} [o.every]          pages per part
 * @param {number[]} [o.at]           1-based pages that start a new part
 * @param {{page:number,title:string}[]} [o.starts]  0-based bookmark starts
 * @returns {{ parts: { name: string, pages: number[], label: string }[] } | { error: string }}
 */
export function planSplit({ count, base, mode, every, at = [], starts = [] }) {
  let bounds; // [{ from, to, title? }] 0-based inclusive
  if (mode === 'every') {
    const n = Math.floor(Number(every));
    if (!(n >= 1)) return { error: 'every' };
    if (n >= count) return { error: 'oneFile' };
    bounds = [];
    for (let i = 0; i < count; i += n) bounds.push({ from: i, to: Math.min(count, i + n) - 1 });
  } else if (mode === 'at') {
    const cuts = [...new Set(at.map(Number))].filter((p) => Number.isInteger(p) && p > 1 && p <= count).sort((a, b) => a - b);
    if (!cuts.length) return { error: 'at' };
    const edges = [1, ...cuts, count + 1];
    bounds = edges.slice(0, -1).map((p, k) => ({ from: p - 1, to: edges[k + 1] - 2 }));
  } else if (mode === 'bookmarks') {
    const sorted = [...starts].filter((s) => Number.isInteger(s.page) && s.page >= 0 && s.page < count).sort((a, b) => a.page - b.page);
    const unique = sorted.filter((s, k) => k === 0 || s.page !== sorted[k - 1].page);
    if (!unique.length) return { error: 'bookmarks' };
    bounds = [];
    if (unique[0].page > 0) bounds.push({ from: 0, to: unique[0].page - 1, title: null });
    unique.forEach((s, k) => bounds.push({ from: s.page, to: (unique[k + 1]?.page ?? count) - 1, title: s.title }));
    if (bounds.length < 2) return { error: 'oneFile' };
  } else {
    return { error: 'mode' };
  }
  const width = String(bounds.length).length < 2 ? 2 : String(bounds.length).length;
  const parts = bounds.map((b, k) => {
    const pages = Array.from({ length: b.to - b.from + 1 }, (_, i) => b.from + i);
    const range = formatPageRange(pages).replace(/, /g, '_');
    const label = mode === 'bookmarks' ? (b.title ?? null) : null;
    const tail = mode === 'bookmarks' ? (b.title ? slug(b.title) : 'start') : `pages-${range}`;
    return { name: `${base}-${pad(k + 1, width)}-${tail}.pdf`, pages, label, range: formatPageRange(pages) };
  });
  return { parts };
}
