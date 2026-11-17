// Shared Playwright fixtures for end-to-end tests.
//
// - Requests to the pinned jsDelivr URLs are served from node_modules, so the
//   suite runs offline and deterministically. The installed package version
//   must equal the pinned version in src/core/libs.config.js.
// - Any other network request fails the test: the app must never phone home.
// - Console errors and uncaught page errors fail the test.
import { test as base, expect } from '@playwright/test';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CDN_BASE, LIBS } from '../../src/core/libs.config.js';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
export const APP_URL = pathToFileURL(join(ROOT, 'dist/pdf-editor.html')).href;
export const FIXTURES = join(ROOT, 'tests/fixtures');
export const manifest = JSON.parse(readFileSync(join(FIXTURES, 'manifest.json'), 'utf8'));
export const fixture = (name) => join(FIXTURES, name);

const MIME = {
  '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json',
  '.wasm': 'application/wasm', '.css': 'text/css', '.map': 'application/json',
};

const installed = new Map();
function installedVersion(pkg) {
  if (!installed.has(pkg)) {
    const file = join(ROOT, 'node_modules', pkg, 'package.json');
    installed.set(pkg, existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')).version : null);
  }
  return installed.get(pkg);
}

/** Resolve a jsDelivr URL to a file in node_modules, or explain why not. */
export function resolveCdn(url) {
  const path = decodeURIComponent(url.slice(CDN_BASE.length + 1));
  const m = path.match(/^((?:@[^/]+\/)?[^@/]+)@([^/]+)\/(.+)$/);
  if (!m) return { error: `unparseable CDN URL ${url}` };
  const [, pkg, version, file] = m;
  const lib = Object.values(LIBS).find((l) => l.pkg === pkg);
  if (!lib) return { error: `${pkg} is not in libs.config.js` };
  if (lib.version !== version) return { error: `${pkg}@${version} requested but ${lib.version} is pinned` };
  const have = installedVersion(pkg);
  if (have !== version) return { error: `${pkg}@${version} is pinned but node_modules has ${have}` };
  const full = join(ROOT, 'node_modules', pkg, file);
  if (!existsSync(full)) return { error: `missing file ${pkg}/${file}`, status: 404 };
  return { file: full };
}

export const test = base.extend({
  // Collected problems; asserted empty after every test.
  problems: async ({}, use) => {
    const problems = { console: [], network: [] };
    await use(problems);
  },

  context: async ({ context, problems }, use) => {
    await context.route(/^https?:\/\//, async (route) => {
      const url = route.request().url();
      if (!url.startsWith(CDN_BASE + '/')) {
        problems.network.push(`unexpected request: ${url}`);
        return route.abort('blockedbyclient');
      }
      const r = resolveCdn(url);
      if (r.error) {
        problems.network.push(r.error);
        return route.fulfill({ status: r.status ?? 500, body: r.error });
      }
      return route.fulfill({
        status: 200,
        body: readFileSync(r.file),
        headers: {
          'content-type': MIME[extname(r.file)] ?? 'application/octet-stream',
          'access-control-allow-origin': '*',
        },
      });
    });
    await use(context);
  },

  page: async ({ page, problems }, use) => {
    page.on('console', (msg) => {
      if (msg.type() === 'error') problems.console.push(`console.error: ${msg.text()}`);
    });
    page.on('pageerror', (err) => problems.console.push(`pageerror: ${err.message}`));
    await use(page);
    expect(problems.console, 'no console errors').toEqual([]);
    expect(problems.network, 'no unexpected network requests').toEqual([]);
  },
});

export { expect };

/** Open the built app and wait until it has started. */
export async function openApp(page) {
  await page.goto(APP_URL);
  await page.waitForSelector('html[data-ready="true"]');
}

/** Screenshot into test-results/screenshots/ for manual review. */
export async function shot(page, name) {
  await page.screenshot({ path: join(ROOT, 'test-results/screenshots', `${name}.png`), fullPage: false });
}
