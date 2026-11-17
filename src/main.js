// Entry point.
import { setLocale } from './i18n/index.js';
import { initTheme } from './ui/theme.js';
import { createShell } from './ui/shell.js';
import { createHome } from './ui/home.js';
import { registerCatalogue } from './tools/catalogue.js';
import * as registry from './tools/registry.js';
import * as libs from './core/libs.js';
import { LIBS } from './core/libs.config.js';
import { VERSION } from './core/version.js';

function start() {
  setLocale('en');
  initTheme();
  registerCatalogue();

  const root = document.getElementById('app');
  const { main } = createShell(root);
  createHome(main);

  root.removeAttribute('aria-busy');
  document.documentElement.dataset.ready = 'true';

  // A small, stable handle for diagnostics and end-to-end tests.
  window.pdfEditor = Object.freeze({ version: VERSION, registry, libs, libsConfig: LIBS });
}

start();
