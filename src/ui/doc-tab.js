// One open document: its pdf.js document, viewer, status bar and view state.
// Hidden tabs keep their viewer in the DOM (display:none), so zoom, scroll,
// layout and rendered pages survive switching; the text selection is saved
// and restored explicitly.
import { h } from './dom.js';
import { Viewer } from '../view/viewer.js';
import { createStatusBar } from './statusbar.js';

let nextId = 1;

export class DocTab extends EventTarget {
  /**
   * @param {object} o
   * @param {string} o.name
   * @param {Uint8Array} o.bytes
   * @param {string} o.contentId
   * @param {object} o.pdf       PDFDocumentProxy
   * @param {object} o.pdfjs
   * @param {string|null} o.password
   * @param {object} o.view      initial view: { zoom, mode, cover, rotation, page?, anchor? }
   */
  constructor({ name, bytes, contentId, pdf, pdfjs, password, view }) {
    super();
    this.id = `t${nextId++}`;
    this.name = name;
    this.bytes = bytes;
    this.contentId = contentId;
    this.pdf = pdf;
    this.password = password;
    this.dirty = false;
    this.savedRange = null;
    this.initialView = view;
    this.host = h('div.viewer-host', {
      id: `tabpanel-${this.id}`,
      role: 'tabpanel',
      'aria-labelledby': `tab-${this.id}`,
      dataset: { tabId: this.id },
    });
    this.viewer = new Viewer(this.host, {
      pdfjs,
      doc: pdf,
      zoom: view.zoom,
      mode: view.mode,
      cover: view.cover,
      rotation: view.rotation ?? 0,
    });
    this.statusbar = createStatusBar(this.viewer);
  }

  async init() {
    await this.viewer.init();
    const v = this.initialView;
    if (v.anchor) this.viewer.restoreAnchor(v.anchor);
    else if (v.page > 1) this.viewer.goToPage(v.page);
  }

  setDirty(dirty) {
    if (this.dirty === dirty) return;
    this.dirty = dirty;
    this.dispatchEvent(new CustomEvent('dirtychange'));
  }

  /** Everything needed to reopen this tab where it was. */
  viewState() {
    const v = this.viewer;
    return {
      zoom: v.zoomMode,
      mode: v.mode,
      cover: v.cover,
      rotation: v.rotation,
      page: v.currentPage,
      anchor: v.captureAnchor(0, 0),
    };
  }

  show() {
    this.host.hidden = false;
    if (this.savedRange) {
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(this.savedRange);
    }
    this.viewer.scheduleUpdate();
  }

  hide() {
    const sel = window.getSelection();
    this.savedRange = sel.rangeCount && this.host.contains(sel.anchorNode) ? sel.getRangeAt(0).cloneRange() : null;
    this.host.hidden = true;
  }

  destroy() {
    this.dispatchEvent(new CustomEvent('destroy'));
    this.find?.destroy();
    this.viewer.destroy();
    this.pdf.loadingTask.destroy();
    this.host.remove();
  }
}
