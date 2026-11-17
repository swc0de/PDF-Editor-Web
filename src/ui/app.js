// The application controller: tabs of open documents, the shell (menus,
// tools panel, side panel, status bar), commands, recents, drag-and-drop,
// Read mode and full screen.
import { h } from './dom.js';
import { icon } from './icons.js';
import { t } from '../i18n/index.js';
import { createShell } from './shell.js';
import { createHome } from './home.js';
import { createTabStrip } from './tabs.js';
import { createMenubar } from './menubar.js';
import { createToolsPanel } from './tools-panel.js';
import { createSidePanel } from './side-panel.js';
import { buildMenus } from './app-menus.js';
import { registerAppCommands } from './app-commands.js';
import { openMenu, isMenuOpen } from './menu.js';
import { openPalette } from './palette.js';
import { toast } from './toast.js';
import { alertDialog, confirmDialog, promptPassword } from './dialog.js';
import { handleShortcut, listCommands, primaryShortcut } from './commands.js';
import { DocTab } from './doc-tab.js';
import { createFindBar } from './find-bar.js';
import { FindController } from '../view/find-controller.js';
import { getPdfjs, openPdf, isPasswordCancel } from '../view/pdfjs.js';
import { runTool, getTool, listTools } from '../tools/registry.js';
import { getSetting, getArrangement, saveArrangement, resetArrangement, onSettingsChange } from '../core/settings.js';
import { contentId, addRecent, setRecentThumbnail, getRecentBytes, removeRecent, clearRecents } from '../core/recents.js';

const LOADING_DELAY = 150;
const MAX_CLOSED = 10;
const THUMB_WIDTH = 180;

export class App extends EventTarget {
  constructor(root) {
    super();
    this.root = root;
    this.tabs = [];
    this.activeTab = null; // null = Home
    this.closedTabs = [];
    this.readMode = false;
    this.arrangement = getArrangement();

    this.shell = createShell(root, { onPalette: () => this.openPalette() });
    this.home = createHome(this.shell.main, {
      onOpen: () => this.pickFile(),
      onTool: (id) => this.useTool(id),
      onOpenRecent: (rec) => this.openRecent(rec),
      onRemoveRecent: (rec) => removeRecent(rec.id),
      onClearRecents: () => this.clearRecents(),
    });

    this.tabStrip = createTabStrip({
      onActivate: (id) => this.activate(id ? this.tabs.find((tab) => tab.id === id) : null),
      onClose: (id) => this.closeTab(this.tabs.find((tab) => tab.id === id)),
      onContextMenu: (id, at, anchor) => this.tabContextMenu(this.tabs.find((tab) => tab.id === id), at, anchor),
      onOpen: () => this.pickFile(),
    });
    this.shell.tabsSlot.append(this.tabStrip.el);

    this.toolsPanel = createToolsPanel({
      onTool: (id) => this.useTool(id),
      getState: () => this.arrangement.tools,
      setState: (patch) => this.updateArrangement('tools', patch),
      side: () => getSetting('toolsSide'),
    });
    this.sidePanel = createSidePanel({
      getTab: () => this.activeTab,
      getState: () => this.arrangement.side,
      setState: (patch) => this.updateArrangement('side', patch),
      app: this,
    });
    this.toolsPanel.splitter.classList.add('tools-splitter');
    this.sidePanel.splitter.classList.add('side-splitter');
    const ws = this.shell.workspace;
    ws.prepend(this.toolsPanel.panel, this.toolsPanel.splitter);
    ws.append(this.sidePanel.splitter, this.sidePanel.panel, this.sidePanel.rail);

    this.fileInput = h('input', {
      type: 'file',
      id: 'file-input',
      accept: 'application/pdf,.pdf',
      multiple: true,
      hidden: true,
      tabindex: '-1',
    });
    this.fileInput.addEventListener('change', async () => {
      const files = [...(this.fileInput.files ?? [])];
      this.fileInput.value = '';
      for (const file of files) await this.openFile(file);
    });
    root.append(this.fileInput);

    this.findBar = createFindBar({
      getController: () => this.findController(this.activeTab),
      onClose: () => this.closeFind(),
    });
    this.shell.main.append(this.findBar.el);

    registerAppCommands(this);
    this.menubar = createMenubar(buildMenus(this), { label: t('menu.label') });
    this.shell.menubarSlot.append(this.menubar.el);

    this.applySettings();
    onSettingsChange((key) => {
      if (key === 'toolsSide') this.applySettings();
    });
    this.applyArrangement();
    this.renderTabs();
    this.bindKeys();
    this.bindDragAndDrop();
  }

  get viewer() {
    return this.activeTab?.viewer ?? null;
  }

  // ------------------------------------------------------- arrangement

  applySettings() {
    this.shell.setToolsSide(getSetting('toolsSide'));
  }

  applyArrangement() {
    this.toolsPanel.render();
    this.sidePanel.render();
  }

  updateArrangement(which, patch) {
    this.arrangement = { ...this.arrangement, [which]: { ...this.arrangement[which], ...patch } };
    saveArrangement(this.arrangement);
    this.applyArrangement();
  }

  toggleToolsPanel() {
    this.updateArrangement('tools', { visible: !this.arrangement.tools.visible });
  }

  toggleSidePanel() {
    this.updateArrangement('side', { visible: !this.arrangement.side.visible });
  }

  showPanel(id) {
    this.updateArrangement('side', { visible: true, panel: id });
  }

  resetArrangement() {
    this.arrangement = resetArrangement();
    this.applyArrangement();
    toast(t('arrangement.reset'));
  }

  // -------------------------------------------------------------- tabs

  renderTabs() {
    this.tabStrip.render(this.tabs, this.activeTab?.id ?? null);
  }

  /** Show a tab, or the Home screen when tab is null. */
  activate(tab) {
    if (tab === this.activeTab && (tab || !this.home.hidden)) return;
    this.activeTab?.hide();
    this.activeTab = tab ?? null;
    this.home.hidden = !!tab;
    if (tab) {
      tab.show();
      this.shell.setStatusBar(tab.statusbar.el);
      document.title = `${tab.name} — ${t('app.name')}`;
      tab.viewer.focus();
    } else {
      this.exitReadMode();
      this.closeFind();
      this.shell.setStatusBar(null);
      document.title = t('app.name');
    }
    this.findBar.rebind();
    this.renderTabs();
    this.sidePanel.render();
    this.dispatchEvent(new CustomEvent('tabchange'));
  }

  nextTab(dir) {
    if (!this.tabs.length) return;
    const i = this.activeTab ? this.tabs.indexOf(this.activeTab) : -1;
    this.activate(this.tabs[(i + dir + this.tabs.length) % this.tabs.length]);
  }

  async closeTab(tab, { force = false } = {}) {
    if (!tab) return false;
    if (tab.dirty && !force) {
      const ok = await confirmDialog({
        title: t('close.dirty.title', { name: tab.name }),
        message: t('close.dirty.message'),
        confirmLabel: t('close.dirty.discard'),
        danger: true,
      });
      if (!ok) return false;
    }
    const index = this.tabs.indexOf(tab);
    this.closedTabs.push({
      name: tab.name,
      bytes: tab.bytes,
      password: tab.password,
      view: tab.viewState(),
    });
    if (this.closedTabs.length > MAX_CLOSED) this.closedTabs.shift();
    this.tabs.splice(index, 1);
    if (this.activeTab === tab) {
      this.activeTab = null;
      this.activate(this.tabs[Math.min(index, this.tabs.length - 1)] ?? null);
    }
    tab.destroy();
    this.renderTabs();
    this.dispatchEvent(new CustomEvent('tabclosed'));
    return true;
  }

  async closeOtherTabs(keep) {
    for (const tab of [...this.tabs]) {
      if (tab !== keep) await this.closeTab(tab);
    }
    if (keep) this.activate(keep);
  }

  async reopenClosedTab() {
    const last = this.closedTabs.pop();
    if (!last) return null;
    return this.openBytes(last.bytes, last.name, { password: last.password, view: last.view });
  }

  tabContextMenu(tab, at, anchor) {
    if (!tab) return;
    openMenu(anchor, [
      { id: 'tab-close', label: t('tabs.close'), shortcut: primaryShortcut('tab.close'), run: () => this.closeTab(tab) },
      { id: 'tab-close-others', label: t('tabs.closeOthers'), disabled: this.tabs.length < 2, run: () => this.closeOtherTabs(tab) },
      'separator',
      { id: 'tab-reopen', label: t('tabs.reopen'), shortcut: primaryShortcut('tab.reopen'), disabled: !this.closedTabs.length, run: () => this.reopenClosedTab() },
    ], { at, label: tab.name });
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

  async openRecent(rec) {
    const bytes = rec.stored ? await getRecentBytes(rec.id) : null;
    if (!bytes) {
      toast(t('home.recents.missing', { name: rec.name }));
      this.pickFile();
      return null;
    }
    return this.openBytes(bytes, rec.name);
  }

  async clearRecents() {
    const ok = await confirmDialog({
      title: t('home.recents.clearTitle'),
      message: t('home.recents.clearMessage'),
      confirmLabel: t('home.recents.clear'),
      danger: true,
    });
    if (ok) await clearRecents();
  }

  defaultView() {
    const layout = getSetting('defaultLayout');
    return {
      zoom: getSetting('defaultZoom'),
      mode: layout === 'two-up-cover' ? 'two-up' : layout,
      cover: layout === 'two-up-cover',
      rotation: 0,
    };
  }

  /**
   * Open PDF bytes in a new tab (or switch to the tab that already has them).
   * @param {Uint8Array} bytes
   * @param {string} name
   * @param {{ password?: string, view?: object }} [o]
   */
  async openBytes(bytes, name, { password = null, view = null } = {}) {
    const id = await contentId(bytes);
    const existing = this.tabs.find((tab) => tab.contentId === id);
    if (existing) {
      this.activate(existing);
      return existing;
    }

    const loading = this.showLoading(name);
    let result;
    try {
      result = await openPdf(bytes, {
        password,
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

    const tab = new DocTab({
      name,
      bytes,
      contentId: id,
      pdf: result.doc,
      pdfjs,
      password: result.password,
      view: view ?? this.defaultView(),
    });
    tab.viewer.addEventListener('externallink', (e) => this.openExternalLink(e.detail.url));
    tab.addEventListener('dirtychange', () => this.renderTabs());
    this.tabs.push(tab);
    this.shell.main.append(tab.host);
    this.activate(tab);
    await tab.init();
    this.rememberRecent(tab);
    this.dispatchEvent(new CustomEvent('documentopened', { detail: { name, tab } }));
    return tab;
  }

  /** Save to recents, then add a first-page thumbnail in the background. */
  async rememberRecent(tab) {
    const ok = await addRecent({ id: tab.contentId, name: tab.name, bytes: tab.bytes, pageCount: tab.pdf.numPages });
    if (!ok) return;
    try {
      const page = await tab.pdf.getPage(1);
      const vp1 = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: THUMB_WIDTH / vp1.width });
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(viewport.width);
      canvas.height = Math.round(viewport.height);
      await page.render({ canvas, viewport }).promise;
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
      canvas.width = 0;
      if (blob) await setRecentThumbnail(tab.contentId, blob);
    } catch {
      /* no thumbnail: the card shows a generic icon */
    }
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
    if (!this.activeTab) {
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

  // -------------------------------------------------------------- find

  findController(tab) {
    if (!tab) return null;
    tab.find ??= new FindController(tab.viewer);
    return tab.find;
  }

  openFind() {
    if (!this.activeTab) {
      toast(t('find.needsDocument'));
      return;
    }
    this.findBar.open();
  }

  closeFind() {
    if (!this.findBar?.isOpen) return;
    this.findBar.close();
    this.viewer?.focus();
  }

  // ------------------------------------------------------ tools/palette

  async useTool(id) {
    const tool = getTool(id);
    if (!tool) return;
    if (tool.status !== 'ready') {
      toast(t('status.soonToast', { name: t(tool.label) }));
      return;
    }
    await runTool(id, { app: this });
  }

  paletteItems() {
    const commands = listCommands()
      .filter((c) => !c.hidden)
      .map((c) => ({
        id: c.id,
        label: t(c.label),
        group: t(`menu.${c.id.split('.')[0]}`),
        icon: c.icon,
        shortcut: primaryShortcut(c.id),
        disabled: !c.enabled(),
        run: () => c.run(),
      }));
    const tools = listTools().map((tool) => ({
      id: `tool:${tool.id}`,
      label: t(tool.label),
      group: t('palette.tool'),
      icon: tool.icon,
      shortcut: tool.shortcut,
      hint: tool.status === 'ready' ? null : t('status.soon'),
      run: () => this.useTool(tool.id),
    }));
    return [...commands, ...tools];
  }

  openPalette() {
    openPalette(() => this.paletteItems());
  }

  // ------------------------------------------------------- input wiring

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
    window.addEventListener('drop', async (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      overlay.hidden = true;
      const files = [...e.dataTransfer.files];
      const pdfs = files.filter((f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name));
      for (const file of pdfs.length ? pdfs : files.slice(0, 1)) await this.openFile(file);
    });
  }
}
