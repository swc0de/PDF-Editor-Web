// Background text index for one document, built page by page. Each page's
// text is the concatenation of its pdf.js text items (a space after items
// that end a line), and every item's offset is kept so matches can be mapped
// back onto the text layer's spans (which are created one per item).

const YIELD_EVERY_MS = 12;
const EMIT_EVERY_MS = 120;

export class TextIndex extends EventTarget {
  constructor(doc) {
    super();
    this.doc = doc;
    this.pages = new Array(doc.numPages).fill(null);
    this.indexed = 0;
    this.done = false;
    this.cancelled = false;
    this.running = null;
  }

  /** Start (or keep) indexing; resolves when every page is indexed. */
  start() {
    if (!this.running) this.running = this.run();
    return this.running;
  }

  async run() {
    let lastEmit = performance.now();
    let lastYield = performance.now();
    for (let i = 0; i < this.pages.length; i++) {
      if (this.cancelled) return;
      if (this.pages[i]) continue;
      this.pages[i] = await this.indexPage(i);
      this.indexed++;
      const now = performance.now();
      if (now - lastYield > YIELD_EVERY_MS) {
        await new Promise((r) => setTimeout(r, 0)); // keep the UI responsive
        lastYield = performance.now();
      }
      if (now - lastEmit > EMIT_EVERY_MS) {
        lastEmit = now;
        this.dispatchEvent(new CustomEvent('progress'));
      }
    }
    this.done = true;
    this.dispatchEvent(new CustomEvent('progress'));
  }

  async indexPage(i) {
    try {
      const page = await this.doc.getPage(i + 1);
      const content = await page.getTextContent({ disableNormalization: true });
      let text = '';
      const items = [];
      for (const item of content.items) {
        if (item.str === undefined) continue; // marked-content markers
        items.push({ start: text.length, len: item.str.length });
        text += item.str;
        if (item.hasEOL) text += ' ';
      }
      return { text, items };
    } catch {
      return { text: '', items: [], error: true };
    }
  }

  cancel() {
    this.cancelled = true;
  }
}

/** Build the search RegExp for a query, or null for an empty query. */
export function buildQuery(query, { matchCase = false, wholeWord = false } = {}) {
  const q = query.trim();
  if (!q) return null;
  let src = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  if (wholeWord) src = `(?<![\\p{L}\\p{N}_])${src}(?![\\p{L}\\p{N}_])`;
  return new RegExp(src, `gu${matchCase ? '' : 'i'}`);
}

/** All matches of a RegExp in a page's text, as [start, end) pairs. */
export function findInText(text, re) {
  const out = [];
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m[0].length === 0) {
      re.lastIndex++;
      continue;
    }
    out.push([m.index, m.index + m[0].length]);
  }
  return out;
}
