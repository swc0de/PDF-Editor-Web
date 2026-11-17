// One open document: its editable model (bytes + undo history), the pdf.js
// document for the current bytes, the viewer, status bar and view state.
// Hidden tabs keep their viewer in the DOM (display:none), so zoom, scroll,
// layout and rendered pages survive switching; the text selection is saved
// and restored explicitly.
import { h } from './dom.js';
import { Viewer } from '../view/viewer.js';
import { openPdf, destroyPdf } from '../view/pdfjs.js';
import { createStatusBar } from './statusbar.js';
import { DocumentModel } from '../core/document-model.js';
import { t } from '../i18n/index.js';
import { invalidateThumbs } from './thumbnails.js';

let nextId = 1;

export class DocTab extends EventTarget {
  /**
   * @param {object} o
   * @param {string} o.name
   * @param {Uint8Array} o.bytes
   * @param {string} o.contentId
   * @param {object} o.pdf       PDFDocumentProxy for `bytes`
   * @param {object} o.pdfjs
   * @param {string|null} o.password
   * @param {object} o.view      initial view: { zoom, mode, cover, rotation, page?, anchor? }
   * @param {any} [o.fileHandle] FileSystemFileHandle to save back to
   * @param {boolean} [o.clean]  false: starts with unsaved changes (recovered work)
   * @param {string} [o.autosaveId]
   */
  constructor({ name, bytes, contentId, pdf, pdfjs, password, view, fileHandle = null, clean = true, autosaveId = null, openLabel = null }) {
    super();
    this.id = `t${nextId++}`;
    this.name = name;
    this.contentId = contentId;
    this.autosaveId = autosaveId ?? contentId;
    this.pdf = pdf;
    this.password = password;
    this.savedRange = null;
    this.initialView = view;
    this.lastAutosaved = null;
    this.applying = Promise.resolve();

    this.model = new DocumentModel({
      bytes,
      pageCount: pdf.numPages,
      openLabel: openLabel ?? (clean ? t('history.opened', { name }) : t('history.recovered', { name })),
      clean,
      // pdf-lib can't edit encrypted files.
      readOnly: password ? 'encrypted' : null,
      onChange: (change) => this.applyChange(change),
    });
    this.model.fileHandle = fileHandle;
    this.model.addEventListener('dirtychange', () => this.dispatchEvent(new CustomEvent('dirtychange')));
    this.model.addEventListener('historychange', () => this.dispatchEvent(new CustomEvent('historychange')));

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

  get bytes() {
    return this.model.bytes;
  }

  get dirty() {
    return this.model.dirty;
  }

  async init() {
    await this.viewer.init();
    const v = this.initialView;
    if (v.anchor) this.viewer.restoreAnchor(v.anchor);
    else if (v.page > 1) this.viewer.goToPage(v.page);
  }

  /**
   * The model moved to another state: load its bytes into pdf.js and let the
   * viewer re-render only what changed.
   */
  async applyChange({ to, affected, structural }) {
    const { doc } = await openPdf(to.bytes, { password: this.password, askPassword: async () => null });
    const old = this.pdf;
    this.pdf = doc;
    await this.viewer.replaceDocument(doc, { affected, structural });
    destroyPdf(old);
    // Derived data that may be stale now.
    this.find?.destroy();
    this.find = null;
    this.outlinePromise = null;
    invalidateThumbs(this, { affected, structural });
    this.dispatchEvent(new CustomEvent('docchange', { detail: { affected, structural } }));
  }

  rename(name) {
    this.name = name;
    this.dispatchEvent(new CustomEvent('rename'));
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
    this.organizer?.destroy();
    this.viewer.destroy();
    destroyPdf(this.pdf);
    this.model.dispose();
    this.host.remove();
  }
}
