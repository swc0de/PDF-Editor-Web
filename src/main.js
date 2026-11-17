// Entry point.
import { setLocale } from './i18n/index.js';
import { initTheme } from './ui/theme.js';
import { App } from './ui/app.js';
import { registerCatalogue } from './tools/catalogue.js';
import { registerReadMode } from './tools/read-mode.js';
import { registerNavigationTools } from './tools/navigation.js';
import { registerPagesPanel } from './ui/panels/pages-panel.js';
import { registerBookmarksPanel } from './ui/panels/bookmarks-panel.js';
import * as registry from './tools/registry.js';
import * as commands from './ui/commands.js';
import * as libs from './core/libs.js';
import { LIBS } from './core/libs.config.js';
import { VERSION } from './core/version.js';

function start() {
  setLocale('en');
  initTheme();
  registerCatalogue();
  registerReadMode();
  registerNavigationTools();
  registerPagesPanel();
  registerBookmarksPanel();

  const root = document.getElementById('app');
  const app = new App(root);

  root.removeAttribute('aria-busy');
  document.documentElement.dataset.ready = 'true';

  // A small, stable handle for diagnostics and end-to-end tests.
  window.pdfEditor = Object.freeze({ version: VERSION, app, registry, commands, libs, libsConfig: LIBS });
}

start();
