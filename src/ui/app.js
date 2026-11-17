// The application controller: tabs of open documents, the shell (menus,
// tools panel, side panel, status bar), commands, recents, drag-and-drop,
// Read mode and full screen.
import { h } from './dom.js';
import { icon } from './icons.js';
import { t, tn } from '../i18n/index.js';
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
import { alertDialog, confirmDialog, openDialog, promptPassword } from './dialog.js';
import { saveTab } from './save.js';
import { canvasToBlob } from './canvas-encode.js';
import { writeAutosave, deleteAutosave, listAutosaves } from '../core/autosave.js';
import { handleShortcut, listCommands, primaryShortcut, commandLabel } from './commands.js';
import { DocTab } from './doc-tab.js';
import { createFindBar } from './find-bar.js';
import { FindController } from '../view/find-controller.js';
import { Organizer } from './organize/organizer.js';
import { openCombineDialog } from './combine/combine-dialog.js';
import { openSplitDialog } from './combine/split-dialog.js';
import { openExtractDialog } from './combine/extract-dialog.js';
import { runJob } from '../core/jobs.js';
import { formatPageRange } from '../core/page-range.js';
import { getPdfjs, openPdf, isPasswordCancel } from '../view/pdfjs.js';
import { Annotator } from './annotate/annotator.js';
import { registerAnnotateCommands } from '../tools/annotate.js';
import { runTool, getTool, listTools } from '../tools/registry.js';
import { getSetting, getArrangement, saveArrangement, resetArrangement, onSettingsChange } from '../core/settings.js';
import { contentId, addRecent, setRecentThumbnail, getRecentBytes, removeRecent, clearRecents } from '../core/recents.js';

const LOADING_DELAY = 150;
const MAX_CLOSED = 10;
const THUMB_WIDTH = 180;
const AUTOSAVE_MS = 60_000;
const PDF_PICKER_TYPES = [{ description: 'PDF', accept: { 'application/pdf': ['.pdf'] } }];

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
      onRecover: (rec) => this.recover(rec),
      onDiscardRecovery: (rec) => this.discardRecovery(rec),
      isOpen: (autosaveId) => this.tabs.some((tab) => tab.autosaveId === autosaveId),
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
    this.annotator = new Annotator(this);

    registerAppCommands(this);
    registerAnnotateCommands(this);
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
    this.bindAutosave();
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
      this.home.refreshRecovery?.();
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
      if (this.activeTab !== tab) this.activate(tab);
      const choice = await openDialog({
        title: t('close.dirty.title', { name: tab.name }),
        className: 'unsaved-dialog',
        body: h('p', t('close.dirty.message')),
        actions: [
          { label: t('close.dirty.dontSave'), value: 'discard' },
          { label: t('common.cancel'), value: null },
          { label: t('close.dirty.save'), value: 'save', primary: true },
        ],
        cancelValue: null,
      });
      if (!choice) return false;
      if (choice === 'save') {
        if (!(await saveTab(tab))) return false;
        await this.afterSave(tab);
      }
    }
    await tab.model.queue;
    await deleteAutosave(tab.autosaveId);
    const index = this.tabs.indexOf(tab);
    if (index < 0) return false;
    this.closedTabs.push({
      name: tab.name,
      bytes: tab.bytes,
      password: tab.password,
      view: tab.viewState(),
      dirty: tab.dirty,
      handle: tab.model.fileHandle,
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
    return this.openBytes(last.bytes, last.name, {
      password: last.password,
      view: last.view,
      handle: last.handle,
      clean: !last.dirty,
    });
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

  /**
   * Choose files to open. Where the File System Access API exists we use it,
   * so Save can write back to the same file later; otherwise a file input.
   */
  async pickFile() {
    if (typeof window.showOpenFilePicker === 'function') {
      let handles;
      try {
        handles = await window.showOpenFilePicker({ multiple: true, types: PDF_PICKER_TYPES });
      } catch (err) {
        if (err.name === 'AbortError') return;
        this.fileInput.click(); // e.g. blocked in this context
        return;
      }
      for (const handle of handles) await this.openFile(await handle.getFile(), handle);
      return;
    }
    this.fileInput.click();
  }

  async openFile(file, handle = null) {
    let bytes;
    try {
      bytes = new Uint8Array(await file.arrayBuffer());
    } catch (err) {
      this.showOpenError(file.name, err);
      return null;
    }
    return this.openBytes(bytes, file.name, { handle });
  }

  async openRecent(rec) {
    const bytes = rec.stored ? await getRecentBytes(rec.id) : null;
    if (!bytes) {
      toast(t('home.recents.missing', { name: rec.name }));
      this.pickFile();
      return null;
    }
    return this.openBytes(bytes, rec.name, { handle: rec.handle ?? null });
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
  async openBytes(bytes, name, { password = null, view = null, handle = null, clean = true, autosaveId = null, openLabel = null } = {}) {
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
      fileHandle: handle,
      clean,
      autosaveId,
      openLabel,
    });
    tab.viewer.addEventListener('externallink', (e) => this.openExternalLink(e.detail.url));
    tab.addEventListener('dirtychange', () => {
      this.renderTabs();
      if (!tab.dirty) {
        tab.lastAutosaved = null;
        deleteAutosave(tab.autosaveId);
      }
    });
    tab.addEventListener('rename', () => {
      this.renderTabs();
      if (tab === this.activeTab) document.title = `${tab.name} — ${t('app.name')}`;
    });
    tab.addEventListener('docchange', (e) => {
      if (tab !== this.activeTab) return;
      this.findBar.rebind();
      if (e.detail.structural) this.sidePanel.invalidate();
    });
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
    const ok = await addRecent({
      id: tab.contentId,
      name: tab.name,
      bytes: tab.bytes,
      pageCount: tab.pdf.numPages,
      handle: tab.model.fileHandle,
    });
    if (!ok) return;
    try {
      const page = await tab.pdf.getPage(1);
      const vp1 = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: THUMB_WIDTH / vp1.width });
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(viewport.width);
      canvas.height = Math.round(viewport.height);
      await page.render({ canvas, viewport }).promise;
      const blob = await canvasToBlob(canvas);
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

  // ----------------------------------------------------------- editing

  /**
   * Run a document operation on a tab as one named undo step. Resolves to the
   * op's result value (or true), or false if it failed.
   */
  async edit(tab, op, args, label) {
    if (!tab) return false;
    try {
      const value = await tab.model.execute(op, args, label);
      return value ?? true;
    } catch (err) {
      if (err.name === 'ReadOnlyError') toast(t(`edit.readOnly.${err.reason}`), { kind: 'error' });
      else toast(t('edit.failed', { message: err.message }), { kind: 'error', timeout: 6000 });
      return false;
    }
  }

  rotateCurrentPage(delta) {
    const tab = this.activeTab;
    if (!tab) return false;
    const index = tab.viewer.current;
    const label = t(delta > 0 ? 'step.rotatePage' : 'step.rotatePageLeft', { page: tab.viewer.pageLabel(index) });
    return this.edit(tab, 'rotatePages', { pages: [index], delta }, label);
  }

  async undo() {
    await this.activeTab?.model.undo();
  }

  async redo() {
    await this.activeTab?.model.redo();
  }

  async save({ as = false } = {}) {
    const tab = this.activeTab;
    if (!tab) return false;
    const ok = await saveTab(tab, { as });
    if (ok) await this.afterSave(tab);
    return ok;
  }

  /** Keep the recent-files copy in step with what was saved. */
  async afterSave(tab) {
    await deleteAutosave(tab.autosaveId);
    await addRecent({
      id: tab.contentId,
      name: tab.name,
      bytes: tab.bytes,
      pageCount: tab.pdf.numPages,
      handle: tab.model.fileHandle,
    });
  }

  // ---------------------------------------------------------- autosave

  bindAutosave() {
    this.autosave = { runNow: () => this.autosaveNow() };
    this.autosaveTimer = setInterval(() => this.autosaveNow(), AUTOSAVE_MS);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') this.autosaveNow();
    });
    window.addEventListener('pagehide', () => this.autosaveNow());
    // Unsaved work: ask before the page goes away.
    window.addEventListener('beforeunload', (e) => {
      if (!this.tabs.some((tab) => tab.dirty)) return;
      this.autosaveNow();
      e.preventDefault();
      e.returnValue = '';
    });
  }

  /** Write every dirty tab whose state changed since its last autosave. */
  async autosaveNow() {
    const jobs = this.tabs
      .filter((tab) => tab.dirty && tab.lastAutosaved !== tab.model.history.current)
      .map(async (tab) => {
        const entry = tab.model.history.current;
        const ok = await writeAutosave({
          id: tab.autosaveId,
          name: tab.name,
          bytes: entry.bytes,
          handle: tab.model.fileHandle,
          steps: tab.model.history.entries.slice(1, tab.model.history.index + 1).map((e) => e.label),
        });
        if (ok) tab.lastAutosaved = entry;
      });
    await Promise.all(jobs);
    this.home.refreshRecovery?.();
  }

  async recover(rec) {
    const bytes = new Uint8Array(await rec.bytes.arrayBuffer());
    const tab = await this.openBytes(bytes, rec.name, { handle: rec.handle ?? null, clean: false, autosaveId: rec.id });
    this.home.refreshRecovery?.();
    return tab;
  }

  async discardRecovery(rec) {
    const ok = await confirmDialog({
      title: t('recovery.discardTitle', { name: rec.name }),
      message: t('recovery.discardMessage'),
      confirmLabel: t('recovery.discard'),
      danger: true,
    });
    if (!ok) return;
    await deleteAutosave(rec.id);
    this.home.refreshRecovery?.();
  }

  listRecoverable() {
    return listAutosaves();
  }

  // ----------------------------------------------------- combine & split

  openCombine() {
    return openCombineDialog(this);
  }

  /** A tab whose pages pdf-lib can read (not password-protected), or null + a message. */
  editableTab() {
    const tab = this.activeTab;
    if (!tab) {
      toast(t('combine.needsDocument'));
      return null;
    }
    if (tab.model.readOnly) {
      toast(t(`edit.readOnly.${tab.model.readOnly}`), { kind: 'error' });
      return null;
    }
    return tab;
  }

  openSplit() {
    const tab = this.editableTab();
    return tab ? openSplitDialog(this, tab) : null;
  }

  openExtract() {
    const tab = this.editableTab();
    if (!tab) return null;
    const org = tab.organizer;
    const selection = org?.isOpen && org.selection.size ? [...org.selection].sort((a, b) => a - b) : [tab.viewer.current];
    return openExtractDialog(this, tab, selection);
  }

  /**
   * Copy pages (with their links, form fields and bookmarks) into a new,
   * unsaved tab. Returns true on success.
   */
  async extractPages(tab, pages) {
    const bytes = tab.bytes.slice();
    const job = runJob('combine', { files: [{ name: tab.name, bytes, pages }], bookmarks: false }, { transfer: [bytes.buffer] });
    try {
      const result = await job.promise;
      const base = tab.name.replace(/\.pdf$/i, '');
      const name = `${base} (${tn('organize.extractName', pages.length, { range: formatPageRange(pages) })}).pdf`;
      await this.openBytes(result.bytes, name, { clean: false, openLabel: t('history.extracted', { name: tab.name }) });
      return true;
    } catch (err) {
      toast(t('edit.failed', { message: err.message }), { kind: 'error' });
      return false;
    }
  }

  // ---------------------------------------------------------- organize

  openOrganizer() {
    const tab = this.activeTab;
    if (!tab) {
      toast(t('organize.needsDocument'));
      return null;
    }
    this.closeFind();
    tab.organizer ??= new Organizer(this, tab);
    tab.organizer.show();
    this.dispatchEvent(new CustomEvent('organizerchange'));
    return tab.organizer;
  }

  closeOrganizer() {
    const tab = this.activeTab;
    const org = tab?.organizer;
    if (!org?.isOpen) return;
    org.hide();
    tab.viewer.goToPage(org.focus + 1);
    tab.viewer.focus();
    this.dispatchEvent(new CustomEvent('organizerchange'));
  }

  get organizerOpen() {
    return !!this.activeTab?.organizer?.isOpen;
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
        label: commandLabel(c, t),
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
      // File handles must be requested synchronously, during the drop event.
      const handlePromises = [...e.dataTransfer.items]
        .filter((item) => item.kind === 'file')
        .map((item) => item.getAsFileSystemHandle?.().catch(() => null) ?? Promise.resolve(null));
      const files = [...e.dataTransfer.files];
      const handles = await Promise.all(handlePromises);
      const isPdf = (f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name);
      const picked = files.some(isPdf) ? files.filter(isPdf) : files.slice(0, 1);
      for (const file of picked) {
        const handle = handles[files.indexOf(file)];
        await this.openFile(file, handle?.kind === 'file' ? handle : null);
      }
    });
  }
}
