// Every app command (menus, shortcuts and the palette all use these).
import { defineCommand } from './commands.js';
import { toggleTheme } from './theme.js';
import { openPreferences } from './preferences.js';
import { openAbout, openShortcuts } from './about.js';
import { PANELS } from './panels.js';

export function registerAppCommands(app) {
  const hasDoc = () => !!app.activeTab;
  const v = () => app.viewer;
  const def = (c) => defineCommand(c);

  // File / tabs
  def({ id: 'file.open', label: 'command.file.open', icon: 'folderOpen', shortcut: 'Mod+O', run: () => app.pickFile() });
  def({ id: 'tab.close', label: 'command.tab.close', icon: 'x', shortcut: 'Mod+W', enabled: hasDoc, run: () => app.closeTab(app.activeTab) });
  def({ id: 'tab.closeOthers', label: 'command.tab.closeOthers', enabled: () => app.tabs.length > 1 && hasDoc(), run: () => app.closeOtherTabs(app.activeTab) });
  def({ id: 'tab.reopen', label: 'command.tab.reopen', shortcut: 'Mod+Shift+T', enabled: () => app.closedTabs.length > 0, run: () => app.reopenClosedTab() });
  def({ id: 'tab.next', label: 'command.tab.next', shortcut: 'Ctrl+PageDown', enabled: () => app.tabs.length > 0, run: () => app.nextTab(1) });
  def({ id: 'tab.prev', label: 'command.tab.prev', shortcut: 'Ctrl+PageUp', enabled: () => app.tabs.length > 0, run: () => app.nextTab(-1) });
  def({ id: 'app.home', label: 'command.app.home', icon: 'home', run: () => app.activate(null) });

  // Edit
  def({
    id: 'edit.copy', label: 'command.edit.copy', icon: 'copy',
    enabled: () => !!window.getSelection()?.toString(),
    run: () => document.execCommand('copy'),
  });
  def({
    id: 'edit.selectPageText', label: 'command.edit.selectPageText', enabled: hasDoc,
    run: () => {
      const layer = app.activeTab.host.querySelector(`.page[data-page-number="${v().currentPage}"] .textLayer`);
      if (!layer) return;
      const range = document.createRange();
      range.selectNodeContents(layer);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    },
  });

  // View
  def({ id: 'view.zoomIn', label: 'command.view.zoomIn', icon: 'plus', shortcut: 'Mod+=', enabled: hasDoc, run: () => v().zoomIn() });
  def({ id: 'view.zoomOut', label: 'command.view.zoomOut', icon: 'minus', shortcut: 'Mod+-', enabled: hasDoc, run: () => v().zoomOut() });
  def({ id: 'view.actualSize', label: 'command.view.actualSize', shortcut: 'Mod+0', enabled: hasDoc, run: () => v().setZoom(1) });
  def({ id: 'view.fitWidth', label: 'zoom.fitWidth', icon: 'fitWidth', enabled: hasDoc, checked: () => v()?.zoomMode === 'fit-width', run: () => v().setZoom('fit-width') });
  def({ id: 'view.fitPage', label: 'zoom.fitPage', icon: 'fitPage', enabled: hasDoc, checked: () => v()?.zoomMode === 'fit-page', run: () => v().setZoom('fit-page') });
  def({ id: 'view.layout.continuous', label: 'layout.continuous', icon: 'pageContinuous', enabled: hasDoc, checked: () => v()?.mode === 'continuous', run: () => v().setMode('continuous') });
  def({ id: 'view.layout.single', label: 'layout.single', icon: 'pageSingle', enabled: hasDoc, checked: () => v()?.mode === 'single', run: () => v().setMode('single') });
  def({ id: 'view.layout.twoUp', label: 'layout.twoUp', icon: 'pageTwoUp', enabled: hasDoc, checked: () => v()?.mode === 'two-up' && !v().cover, run: () => v().setMode('two-up', { cover: false }) });
  def({ id: 'view.layout.twoUpCover', label: 'layout.twoUpCover', icon: 'pageCover', enabled: hasDoc, checked: () => v()?.mode === 'two-up' && v().cover, run: () => v().setMode('two-up', { cover: true }) });
  def({ id: 'view.rotateLeft', label: 'command.view.rotateLeft', icon: 'rotateCcw', enabled: hasDoc, run: () => v().rotate(-90) });
  def({ id: 'view.rotateRight', label: 'command.view.rotateRight', icon: 'rotateCw', enabled: hasDoc, run: () => v().rotate(90) });
  def({ id: 'view.toggleToolsPanel', label: 'command.view.toggleToolsPanel', icon: 'panelLeft', shortcut: 'Shift+F4', checked: () => app.arrangement.tools.visible, run: () => app.toggleToolsPanel() });
  def({ id: 'view.toggleSidePanel', label: 'command.view.toggleSidePanel', icon: 'panelRight', shortcut: 'F4', checked: () => app.arrangement.side.visible, run: () => app.toggleSidePanel() });
  def({ id: 'view.resetArrangement', label: 'command.view.resetArrangement', run: () => app.resetArrangement() });
  def({ id: 'view.fullscreen', label: 'command.view.fullscreen', icon: 'maximize', shortcut: 'F11', run: () => app.toggleFullscreen() });
  def({ id: 'view.readMode', label: 'command.view.readMode', icon: 'bookOpen', enabled: hasDoc, run: () => app.toggleReadMode() });
  def({ id: 'view.exitReadMode', label: 'readMode.exit', shortcut: 'Escape', hidden: true, enabled: () => app.readMode, run: () => app.exitReadMode() });
  def({ id: 'view.toggleTheme', label: 'command.view.toggleTheme', icon: 'moon', run: () => toggleTheme() });
  for (const p of PANELS) {
    def({ id: `panel.${p.id}`, label: `command.panel.${p.id}`, icon: p.icon, run: () => app.showPanel(p.id) });
  }

  // Go
  def({ id: 'go.firstPage', label: 'command.go.firstPage', enabled: hasDoc, run: () => v().goToPage(1) });
  def({ id: 'go.lastPage', label: 'command.go.lastPage', enabled: hasDoc, run: () => v().goToPage(v().numPages) });
  def({ id: 'go.nextPage', label: 'status.nextPage', icon: 'chevronRight', enabled: hasDoc, run: () => v().next() });
  def({ id: 'go.prevPage', label: 'status.prevPage', icon: 'chevronLeft', enabled: hasDoc, run: () => v().prev() });

  // App / help
  def({ id: 'app.palette', label: 'command.app.palette', icon: 'search', shortcut: 'Mod+K', hidden: true, run: () => app.openPalette() });
  def({ id: 'app.preferences', label: 'command.app.preferences', icon: 'settings', shortcut: 'Mod+,', run: () => openPreferences() });
  def({ id: 'app.allTools', label: 'command.app.allTools', icon: 'grid', run: () => {
    app.activate(null);
    document.querySelector('.catalogue')?.scrollIntoView({ block: 'start' });
  } });
  def({ id: 'help.shortcuts', label: 'command.help.shortcuts', icon: 'keyboard', shortcut: 'Mod+/', run: () => openShortcuts() });
  def({ id: 'help.about', label: 'command.help.about', icon: 'info', run: () => openAbout() });
}
