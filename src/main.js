// Entry point.
import { setLocale } from './i18n/index.js';
import { initTheme } from './ui/theme.js';
import { App } from './ui/app.js';
import { registerCatalogue } from './tools/catalogue.js';
import { registerReadMode } from './tools/read-mode.js';
import { registerNavigationTools } from './tools/navigation.js';
import { registerPagesPanel } from './ui/panels/pages-panel.js';
import { registerBookmarksPanel } from './ui/panels/bookmarks-panel.js';
import { registerHistoryPanel } from './ui/panels/history-panel.js';
import { registerHistoryTool } from './tools/history.js';
import { registerOrganizeTools } from './tools/organize.js';
import { registerCombineTools } from './tools/combine.js';
import { registerInfoTools } from './tools/info.js';
import { registerAnnotateTools } from './tools/annotate.js';
import { registerCommentsPanel } from './ui/panels/comments-panel.js';
import { registerFormTools } from './tools/forms.js';
import { registerFieldsPanel } from './ui/panels/fields-panel.js';
import { registerProtectTools } from './tools/protect.js';
import { registerLayersPanel } from './ui/panels/layers-panel.js';
import { registerAttachmentsPanel } from './ui/panels/attachments-panel.js';
import { registerPropertiesPanel } from './ui/panels/properties-panel.js';
import * as registry from './tools/registry.js';
import * as commands from './ui/commands.js';
import * as libs from './core/libs.js';
import { LIBS } from './core/libs.config.js';
import { VERSION } from './core/version.js';
import { loadPrefs } from './core/prefs.js';
import { clearAllStores } from './core/idb.js';

async function start() {
  await loadPrefs();
  setLocale('en');
  initTheme();
  registerCatalogue();
  registerReadMode();
  registerNavigationTools();
  registerPagesPanel();
  registerBookmarksPanel();
  registerHistoryPanel();
  registerHistoryTool();
  registerOrganizeTools();
  registerCombineTools();
  registerInfoTools();
  registerAnnotateTools();
  registerCommentsPanel();
  registerFormTools();
  registerFieldsPanel();
  registerProtectTools();
  registerLayersPanel();
  registerAttachmentsPanel();
  registerPropertiesPanel();

  const root = document.getElementById('app');
  const app = new App(root);

  root.removeAttribute('aria-busy');
  document.documentElement.dataset.ready = 'true';

  // A small, stable handle for diagnostics and end-to-end tests.
  window.pdfEditor = Object.freeze({
    version: VERSION, app, registry, commands, libs, libsConfig: LIBS,
    storage: { clearAll: async () => { try { localStorage.clear(); } catch { /* ignore */ } await clearAllStores(); } },
  });
}

start();
