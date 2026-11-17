// The application controller: opens documents, owns the viewer and wires
// commands, drag-and-drop, Read mode and full screen together.
import { h } from './dom.js';
import { icon } from './icons.js';
import { t } from '../i18n/index.js';
import { createShell } from './shell.js';
import { createHome } from './home.js';
import { createStatusBar } from './statusbar.js';
import { toast } from './toast.js';
import { alertDialog, confirmDialog, promptPassword } from './dialog.js';
import { defineCommand, handleShortcut } from './commands.js';
import { isMenuOpen } from './menu.js';
import { toggleTheme } from './theme.js';
import { getPdfjs, openPdf, isPasswordCancel } from '../view/pdfjs.js';
import { Viewer } from '../view/viewer.js';
import { runTool, getTool } from '../tools/registry.js';

const LOADING_DELAY = 150;

export class App extends EventTarget {
  constructor(root) {
    super();
    this.root = root;
    this.doc = null;
    this.readMode = false;
    this.shell = createShell(root, {
      onOpen: () => this.pickFile(),
      onClose: () => this.closeDocument(),
    });
    this.home = createHome(this.shell.main, {
      onOpen: () => this.pickFile(),
      onTool: (id) => this.useTool(id),
    });
    this.fileInput = h('input', {
      type: 'file',
      id: 'file-input',
      accept: 'application/pdf,.pdf',
      hidden: true,
      tabindex: '-1',
    });
    this.fileInput.addEventListener('change', () => {
      const file = this.fileInput.files?.[0];
      this.fileInput.value = '';
      if (file) this.openFile(file);
    });
    root.append(this.fileInput);
    this.registerCommands();
    this.bindKeys();
    this.bindDragAndDrop();
  }

  get viewer() {
    return this.doc?.viewer ?? null;
  }

  // ------------------------------------------------------------ opening

  pickFile() {
    this.fileInput.click();
  }

  async openFile(file) {
    let bytes;
    try {
      bytes = new Uint8Array(await file.arrayBuffer());
    } catch (err) {
      this.showOpenError(file.name, err);
      return null;
    }
    return this.openBytes(bytes, file.name);
  }

  async openBytes(bytes, name) {
    const loading = this.showLoading(name);
    let result;
    try {
      result = await openPdf(bytes, {
        askPassword: (retry) => {
          loading.pause();
          return promptPassword({ filename: name, retry }).finally(() => loading.resume());
        },
        onProgress: (f) => loading.progress(f),
      });
    } catch (err) {
      loading.done();
      if (!isPasswordCancel(err)) this.showOpenError(name, err);
      return null;
    }
    const pdfjs = await getPdfjs();
    loading.done();

    this.closeDocument();
    const host = h('div.viewer-host');
    this.shell.main.append(host);
    this.home.hidden = true;
    const viewer = new Viewer(host, { pdfjs, doc: result.doc });
    viewer.addEventListener('externallink', (e) => this.openExternalLink(e.detail.url));
    const statusbar = createStatusBar(viewer);
    this.shell.setStatusBar(statusbar.el);
    this.shell.setDocument(name);
    document.title = `${name} — ${t('app.name')}`;
    this.doc = { name, bytes, pdf: result.doc, password: result.password, viewer, statusbar, host };
    await viewer.init();
    viewer.focus();
    this.dispatchEvent(new CustomEvent('documentopened', { detail: { name } }));
    return this.doc;
  }

  showOpenError(name, err) {
    let message;
    if (err?.name === 'InvalidPDFException') message = t('open.error.invalid');
    else if (err?.name === 'MissingPDFException') message = t('open.error.missing');
    else if (/fetch|import|load|network/i.test(err?.message ?? '') && !navigator.onLine) message = t('open.error.offline');
    else message = t('open.error.generic', { message: err?.message ?? String(err) });
    alertDialog({ title: t('open.error.title', { name }), message });
  }

  showLoading(name) {
    const bar = h('div.progress-bar', h('div.progress-fill'));
    const el = h('div.loading', { role: 'status', 'aria-live': 'polite' },
      h('div.spinner', { 'aria-hidden': 'true' }),
      h('span', t('open.loading', { name })),
      bar,
    );
    let shown = false;
    const timer = setTimeout(() => {
      shown = true;
      this.shell.main.append(el);
    }, LOADING_DELAY);
    return {
      progress: (f) => bar.firstChild.style.setProperty('width', `${Math.round(f * 100)}%`),
      pause: () => { el.hidden = true; },
      resume: () => { el.hidden = false; },
      done: () => {
        clearTimeout(timer);
        if (shown) el.remove();
      },
    };
  }

  closeDocument() {
    if (!this.doc) return;
    const { viewer, pdf, host } = this.doc;
    this.doc = null;
    this.exitReadMode();
    viewer.destroy();
    pdf.loadingTask.destroy();
    host.remove();
    this.shell.setStatusBar(null);
    this.shell.setDocument(null);
    this.home.hidden = false;
    document.title = t('app.name');
    this.dispatchEvent(new CustomEvent('documentclosed'));
  }

  async openExternalLink(url) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return;
    }
    if (!['http:', 'https:', 'mailto:'].includes(parsed.protocol)) {
      alertDialog({ title: t('link.title'), message: t('link.unsupported', { url }) });
      return;
    }
    const ok = await confirmDialog({
      title: t('link.title'),
      message: [h('p', t('link.message')), h('p.link-url', url)],
      confirmLabel: t('link.open'),
    });
    if (ok) window.open(parsed.href, '_blank', 'noopener,noreferrer');
  }

  // --------------------------------------------- read mode / full screen

  toggleReadMode() {
    if (this.readMode) this.exitReadMode();
    else this.enterReadMode();
  }

  enterReadMode() {
    if (!this.doc) {
      toast(t('readMode.needsDocument'));
      return;
    }
    if (this.readMode) return;
    this.readMode = true;
    document.documentElement.classList.add('read-mode');
    const exit = h('button.btn.read-mode-exit', { type: 'button', onclick: () => this.exitReadMode() },
      icon('x', { size: 14 }), t('readMode.exit'));
    this.readModeExit = exit;
    document.body.append(exit);
    toast(t('readMode.hint'), { timeout: 2500 });
    this.viewer?.focus();
  }

  exitReadMode() {
    if (!this.readMode) return;
    this.readMode = false;
    document.documentElement.classList.remove('read-mode');
    this.readModeExit?.remove();
    this.viewer?.focus();
  }

  async toggleFullscreen() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
    } catch {
      toast(t('fullscreen.unavailable'), { kind: 'error' });
    }
  }

  // -------------------------------------------------------------- tools

  async useTool(id) {
    const tool = getTool(id);
    if (!tool) return;
    if (tool.status !== 'ready') {
      toast(t('status.soonToast', { name: t(tool.label) }));
      return;
    }
    await runTool(id, { app: this });
  }

  // ------------------------------------------------------------ commands

  registerCommands() {
    const hasDoc = () => !!this.doc;
    const v = () => this.viewer;
    defineCommand({ id: 'file.open', label: 'command.file.open', icon: 'folderOpen', shortcut: 'Mod+O', run: () => this.pickFile() });
    defineCommand({ id: 'file.close', label: 'command.file.close', icon: 'x', enabled: hasDoc, run: () => this.closeDocument() });
    defineCommand({ id: 'view.zoomIn', label: 'command.view.zoomIn', icon: 'plus', shortcut: 'Mod+=', enabled: hasDoc, run: () => v().zoomIn() });
    defineCommand({ id: 'view.zoomOut', label: 'command.view.zoomOut', icon: 'minus', shortcut: 'Mod+-', enabled: hasDoc, run: () => v().zoomOut() });
    defineCommand({ id: 'view.actualSize', label: 'command.view.actualSize', shortcut: 'Mod+0', enabled: hasDoc, run: () => v().setZoom(1) });
    defineCommand({ id: 'view.fitWidth', label: 'zoom.fitWidth', icon: 'fitWidth', enabled: hasDoc, run: () => v().setZoom('fit-width') });
    defineCommand({ id: 'view.fitPage', label: 'zoom.fitPage', icon: 'fitPage', enabled: hasDoc, run: () => v().setZoom('fit-page') });
    defineCommand({ id: 'view.layout.continuous', label: 'layout.continuous', icon: 'pageContinuous', enabled: hasDoc, run: () => v().setMode('continuous') });
    defineCommand({ id: 'view.layout.single', label: 'layout.single', icon: 'pageSingle', enabled: hasDoc, run: () => v().setMode('single') });
    defineCommand({ id: 'view.layout.twoUp', label: 'layout.twoUp', icon: 'pageTwoUp', enabled: hasDoc, run: () => v().setMode('two-up', { cover: false }) });
    defineCommand({ id: 'view.layout.twoUpCover', label: 'layout.twoUpCover', icon: 'pageCover', enabled: hasDoc, run: () => v().setMode('two-up', { cover: true }) });
    defineCommand({ id: 'view.rotateLeft', label: 'command.view.rotateLeft', icon: 'rotateCcw', enabled: hasDoc, run: () => v().rotate(-90) });
    defineCommand({ id: 'view.rotateRight', label: 'command.view.rotateRight', icon: 'rotateCw', enabled: hasDoc, run: () => v().rotate(90) });
    defineCommand({ id: 'view.fullscreen', label: 'command.view.fullscreen', icon: 'maximize', shortcut: 'F11', run: () => this.toggleFullscreen() });
    defineCommand({ id: 'view.readMode', label: 'command.view.readMode', icon: 'bookOpen', enabled: hasDoc, run: () => this.toggleReadMode() });
    defineCommand({ id: 'view.exitReadMode', label: 'readMode.exit', shortcut: 'Escape', enabled: () => this.readMode, run: () => this.exitReadMode() });
    defineCommand({ id: 'view.toggleTheme', label: 'command.view.toggleTheme', run: () => toggleTheme() });
    defineCommand({ id: 'go.firstPage', label: 'command.go.firstPage', enabled: hasDoc, run: () => v().goToPage(1) });
    defineCommand({ id: 'go.lastPage', label: 'command.go.lastPage', enabled: hasDoc, run: () => v().goToPage(v().numPages) });
    defineCommand({ id: 'go.nextPage', label: 'status.nextPage', enabled: hasDoc, run: () => v().next() });
    defineCommand({ id: 'go.prevPage', label: 'status.prevPage', enabled: hasDoc, run: () => v().prev() });
  }

  bindKeys() {
    // Show the big viewer focus ring only while navigating by keyboard.
    const root = document.documentElement;
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Tab') root.classList.add('kbd-nav');
    }, true);
    document.addEventListener('pointerdown', () => root.classList.remove('kbd-nav'), true);
    document.addEventListener('keydown', (e) => {
      if (e.defaultPrevented) return;
      if (document.querySelector('dialog[open]') || isMenuOpen()) return;
      handleShortcut(e);
    });
  }

  bindDragAndDrop() {
    const overlay = h('div.drop-overlay', { hidden: true, 'aria-hidden': 'true' },
      h('div.drop-overlay-inner', icon('upload', { size: 32 }), h('span', t('drop.overlay'))));
    document.body.append(overlay);
    let depth = 0;
    const hasFiles = (e) => [...(e.dataTransfer?.types ?? [])].includes('Files');
    window.addEventListener('dragenter', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth++;
      overlay.hidden = false;
    });
    window.addEventListener('dragover', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    });
    window.addEventListener('dragleave', (e) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) overlay.hidden = true;
    });
    window.addEventListener('drop', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      overlay.hidden = true;
      const files = [...e.dataTransfer.files];
      const file = files.find((f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name)) ?? files[0];
      if (file) this.openFile(file);
    });
  }
}
