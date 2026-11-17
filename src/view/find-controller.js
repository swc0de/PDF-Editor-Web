// Find in document for one tab: matches over the background text index,
// highlights in rendered text layers, and the "current match".
import { TextIndex, buildQuery, findInText } from './text-index.js';

export class FindController extends EventTarget {
  /** @param {import('./viewer.js').Viewer} viewer */
  constructor(viewer) {
    super();
    this.viewer = viewer;
    this.index = new TextIndex(viewer.doc);
    this.query = '';
    this.options = { matchCase: false, wholeWord: false };
    this.re = null;
    this.matches = new Array(viewer.numPages).fill(null); // per page: [[s,e],...] or null (not indexed)
    this.total = 0;
    this.current = null; // { page, i }
    this.pendingReveal = null; // page index waiting for its text layer
    this.highlighted = new Set(); // pages with highlight markup applied

    this.onProgress = () => this.absorb();
    this.onTextLayer = (e) => this.handleTextLayer(e.detail.index);
    this.index.addEventListener('progress', this.onProgress);
    viewer.addEventListener('textlayer', this.onTextLayer);
  }

  /** Run (or refresh) a search. Picks the first match at/after the current page. */
  search(query, options = this.options) {
    this.query = query;
    this.options = { ...options };
    this.re = buildQuery(query, this.options);
    this.matches.fill(null);
    this.total = 0;
    this.current = null;
    this.clearHighlights();
    if (!this.re) {
      this.emit();
      return;
    }
    this.index.start();
    this.absorb();
  }

  /** Pick up newly indexed pages. */
  absorb() {
    if (!this.re) return;
    let added = false;
    this.index.pages.forEach((page, p) => {
      if (page && this.matches[p] === null) {
        this.matches[p] = findInText(page.text, this.re);
        this.total += this.matches[p].length;
        if (this.matches[p].length) added = true;
      }
    });
    if (!this.current && this.total) {
      this.current = this.firstFrom(this.viewer.current);
      if (this.current) this.reveal();
    }
    if (added) this.highlightVisible();
    this.emit();
  }

  /** First match on or after page `from`, wrapping around. */
  firstFrom(from) {
    const n = this.matches.length;
    for (let k = 0; k < n; k++) {
      const p = (from + k) % n;
      if (this.matches[p]?.length) return { page: p, i: 0 };
    }
    return null;
  }

  next() {
    this.step(1);
  }

  prev() {
    this.step(-1);
  }

  step(dir) {
    if (!this.total) return;
    const n = this.matches.length;
    let { page, i } = this.current ?? { page: this.viewer.current, i: dir > 0 ? -1 : 0 };
    if (!this.current && !(this.matches[page]?.length)) i = dir > 0 ? -1 : this.matches[page]?.length ?? 0;
    i += dir;
    while (!(this.matches[page] && i >= 0 && i < this.matches[page].length)) {
      page = (page + dir + n) % n;
      i = dir > 0 ? 0 : (this.matches[page]?.length ?? 0) - 1;
    }
    const old = this.current?.page;
    this.current = { page, i };
    if (old !== undefined && old !== page) this.highlightPage(old);
    this.reveal();
    this.emit();
  }

  /** 1-based ordinal of the current match among all matches found so far. */
  get ordinal() {
    if (!this.current) return 0;
    let n = 0;
    for (let p = 0; p < this.current.page; p++) n += this.matches[p]?.length ?? 0;
    return n + this.current.i + 1;
  }

  get state() {
    return {
      query: this.query,
      total: this.total,
      current: this.ordinal,
      complete: this.index.done,
      indexed: this.index.indexed,
      pages: this.matches.length,
    };
  }

  /** Bring the current match into view (rendering its page first if needed). */
  reveal() {
    const { page } = this.current;
    const view = this.viewer.views[page];
    if (view.textLayerObj) {
      this.highlightPage(page);
      const el = view.textLayer.querySelector('.highlight.selected');
      if (el) {
        el.scrollIntoView({ block: 'center', inline: 'nearest' });
        return;
      }
    }
    this.pendingReveal = page;
    this.viewer.goToPage(page + 1);
  }

  handleTextLayer(page) {
    if (!this.re) return;
    this.highlightPage(page);
    if (this.pendingReveal === page) {
      this.pendingReveal = null;
      this.viewer.views[page].textLayer?.querySelector('.highlight.selected')
        ?.scrollIntoView({ block: 'center', inline: 'nearest' });
    }
  }

  highlightVisible() {
    this.viewer.views.forEach((v, p) => {
      if (v.textLayerObj) this.highlightPage(p);
    });
  }

  /** (Re)apply highlight markup on a page's text layer. */
  highlightPage(p) {
    const view = this.viewer.views[p];
    const layer = view?.textLayerObj;
    const indexPage = this.index.pages[p];
    if (!layer || !indexPage) return;
    const divs = layer.textDivs;
    const strs = layer.textContentItemsStr;
    if (divs.length !== indexPage.items.length) return; // can't map safely
    this.unhighlightPage(p);
    const matches = this.matches[p] ?? [];
    if (!matches.length) return;

    // Per text div: list of [from, to, selected] in div-local offsets.
    const segments = new Map();
    matches.forEach(([s, e], mi) => {
      const selected = this.current?.page === p && this.current.i === mi;
      indexPage.items.forEach((item, k) => {
        const from = Math.max(s, item.start);
        const to = Math.min(e, item.start + item.len);
        if (from >= to) return;
        if (!segments.has(k)) segments.set(k, []);
        segments.get(k).push([from - item.start, to - item.start, selected, mi]);
      });
    });
    for (const [k, segs] of segments) {
      const div = divs[k];
      const str = strs[k];
      const frag = document.createDocumentFragment();
      let pos = 0;
      for (const [from, to, selected, mi] of segs) {
        if (from > pos) frag.append(str.slice(pos, from));
        const mark = document.createElement('span');
        // "appended" (pdf.js CSS) keeps the span in the text flow instead of absolute.
        mark.className = selected ? 'highlight appended selected' : 'highlight appended';
        mark.dataset.match = String(mi);
        mark.textContent = str.slice(from, to);
        frag.append(mark);
        pos = to;
      }
      if (pos < str.length) frag.append(str.slice(pos));
      div.replaceChildren(frag);
      div.dataset.highlighted = '';
    }
    this.highlighted.add(p);
  }

  unhighlightPage(p) {
    const layer = this.viewer.views[p]?.textLayerObj;
    if (!layer) return;
    layer.textDivs.forEach((div, k) => {
      if (div.dataset.highlighted !== undefined) {
        div.textContent = layer.textContentItemsStr[k];
        delete div.dataset.highlighted;
      }
    });
    this.highlighted.delete(p);
  }

  clearHighlights() {
    for (const p of [...this.highlighted]) this.unhighlightPage(p);
    this.pendingReveal = null;
  }

  /** Stop highlighting (find bar closed); the index is kept for next time. */
  reset() {
    this.query = '';
    this.re = null;
    this.current = null;
    this.matches.fill(null);
    this.total = 0;
    this.clearHighlights();
    this.emit();
  }

  emit() {
    this.dispatchEvent(new CustomEvent('update'));
  }

  destroy() {
    this.index.cancel();
    this.index.removeEventListener('progress', this.onProgress);
    this.viewer.removeEventListener('textlayer', this.onTextLayer);
  }
}
