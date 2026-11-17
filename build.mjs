#!/usr/bin/env node
// build.mjs — zero-dependency build for PDF Editor.
//
// Produces dist/pdf-editor.html: ONE self-contained file that works from
// file://. How it works:
//
//   CSS  Every <link rel="stylesheet" href="…"> in src/index.html is replaced
//        by an inline <style> with that file's contents.
//
//   JS   We do NOT concatenate modules (that loses ES module semantics: scope,
//        live bindings, cycles). Instead every .js file under src/ is embedded
//        verbatim as a string in a JSON <script> block, with its relative
//        import specifiers rewritten to bare ids ("./ui/home.js" from main.js
//        becomes "@app/ui/home.js"). At startup a tiny classic bootstrap script
//        turns each module into a Blob URL, installs an <script type="importmap">
//        mapping "@app/…" ids to those Blob URLs, then imports "@app/main.js".
//        The browser's own module loader does the rest, so the source runs
//        exactly as it does in development (`npm run dev` serves src/ as-is).
//
//   The build fails on: an import that doesn't resolve to a file, a bare
//   specifier that isn't ours (no npm packages in the browser — libraries come
//   from the CDN URLs in src/core/libs.config.js), or a version mismatch
//   between src/core/version.js and package.json.

import { readFile, writeFile, readdir, mkdir, stat } from 'node:fs/promises';
import { dirname, join, posix, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const SRC = join(ROOT, 'src');
const OUT_DIR = join(ROOT, 'dist');
const OUT = join(OUT_DIR, 'pdf-editor.html');
const ENTRY = 'main.js';
const PREFIX = '@app/';

const started = performance.now();

async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full)));
    else out.push(full);
  }
  return out;
}

const toId = (file) => PREFIX + relative(SRC, file).split(sep).join('/');

function fail(message) {
  console.error(`\n✗ build failed: ${message}\n`);
  process.exit(1);
}

// Matches the specifier of static imports/re-exports and literal dynamic imports.
//   import x from '…'; import { a } from '…'; import '…'; export * from '…';
//   export { a } from '…'; import('…')
const STATIC_RE =
  /(^|[;\s}])((?:import|export)\s*(?:[\w$*{}\s,]+?\s*from\s*)?)(['"])([^'"\n]+)\3/gm;
const DYNAMIC_RE = /(\bimport\s*\(\s*)(['"])([^'"\n]+)\2(\s*\))/g;

async function rewriteModule(file, source, known) {
  const deps = [];
  const fromDir = posix.dirname(toId(file).slice(PREFIX.length));
  const mapSpecifier = (spec) => {
    if (/^https:\/\//.test(spec)) return spec; // pinned CDN URL
    if (spec.startsWith('./') || spec.startsWith('../')) {
      const target = posix.normalize(posix.join(fromDir, spec));
      const id = PREFIX + target;
      if (!known.has(id)) fail(`${relative(ROOT, file)} imports "${spec}", which doesn't exist`);
      deps.push(id);
      return id;
    }
    return fail(`${relative(ROOT, file)} imports "${spec}" — only relative imports or https CDN URLs are allowed`);
  };
  let out = source.replace(STATIC_RE, (m, lead, head, q, spec) => `${lead}${head}${q}${mapSpecifier(spec)}${q}`);
  out = out.replace(DYNAMIC_RE, (m, head, q, spec, tail) => `${head}${q}${mapSpecifier(spec)}${q}${tail}`);
  return { code: out, deps };
}

function escapeForScript(json) {
  // Safe to embed in <script type="application/json">: no "</script", no "<!--".
  return json.replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

const BOOTSTRAP = `
(function () {
  var data = document.getElementById('app-modules');
  function fail(err) {
    var app = document.getElementById('app');
    var box = document.createElement('div');
    box.className = 'boot-error';
    box.setAttribute('role', 'alert');
    box.textContent = 'PDF Editor could not start: ' + (err && err.message ? err.message : err);
    app.replaceChildren(box);
    app.removeAttribute('aria-busy');
    console.error(err);
  }
  if (!(window.HTMLScriptElement && HTMLScriptElement.supports && HTMLScriptElement.supports('importmap'))) {
    fail(new Error('this browser is too old (it needs ES module import maps).'));
    return;
  }
  try {
    var sources = JSON.parse(data.textContent);
    var imports = {};
    for (var id in sources) {
      var code = sources[id] + '\\n//# sourceURL=pdf-editor:///' + id.slice(${PREFIX.length});
      imports[id] = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
    }
    var map = document.createElement('script');
    map.type = 'importmap';
    map.textContent = JSON.stringify({ imports: imports });
    document.head.appendChild(map);
    window.__pdfEditorBootFail = fail;
    var entry = document.createElement('script');
    entry.type = 'module';
    entry.textContent = 'import(${JSON.stringify(PREFIX + ENTRY)}).catch(function (e) { window.__pdfEditorBootFail(e); });';
    document.body.appendChild(entry);
  } catch (err) {
    fail(err);
  }
})();
`;

async function main() {
  // Version check
  const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
  const versionSrc = await readFile(join(SRC, 'core/version.js'), 'utf8');
  const srcVersion = versionSrc.match(/VERSION\s*=\s*'([^']+)'/)?.[1];
  if (srcVersion !== pkg.version) {
    fail(`src/core/version.js (${srcVersion}) and package.json (${pkg.version}) disagree`);
  }

  let html = await readFile(join(SRC, 'index.html'), 'utf8');

  // 1. Inline stylesheets
  const cssFiles = [];
  html = await replaceAsync(html, /<link\s+rel="stylesheet"\s+href="([^"]+)"\s*\/?>/g, async (m, href) => {
    const file = join(SRC, href);
    const css = await readFile(file, 'utf8').catch(() => fail(`stylesheet not found: ${href}`));
    if (/<\/style/i.test(css)) fail(`${href} contains "</style"`);
    cssFiles.push(href);
    return `<style data-src="${href}">\n${css.trim()}\n</style>`;
  });

  // 2. Collect and rewrite every module
  const files = (await walk(SRC)).filter((f) => f.endsWith('.js'));
  const known = new Set(files.map(toId));
  if (!known.has(PREFIX + ENTRY)) fail(`entry module src/${ENTRY} is missing`);
  const modules = {};
  const graph = new Map();
  for (const file of files.sort()) {
    const { code, deps } = await rewriteModule(file, await readFile(file, 'utf8'), known);
    modules[toId(file)] = code;
    graph.set(toId(file), deps);
  }

  // Warn about modules that nothing imports (likely dead code).
  const reachable = new Set();
  const visit = (id) => {
    if (reachable.has(id)) return;
    reachable.add(id);
    for (const dep of graph.get(id) ?? []) visit(dep);
  };
  visit(PREFIX + ENTRY);
  for (const id of known) if (!reachable.has(id)) console.warn(`  ! unreachable module: ${id}`);

  // 3. Replace the entry <script> with the embedded modules + bootstrap
  const entryTag = new RegExp(`<script\\s+type="module"\\s+src="${ENTRY}"\\s*>\\s*</script>`);
  if (!entryTag.test(html)) fail(`index.html must contain <script type="module" src="${ENTRY}"></script>`);
  const payload = escapeForScript(JSON.stringify(modules));
  html = html.replace(
    entryTag,
    () =>
      `<script type="application/json" id="app-modules">${payload}</script>\n` +
      `  <script>${BOOTSTRAP}</script>`,
  );
  html = html.replace('<head>', `<head>\n  <!-- PDF Editor ${pkg.version} — built by build.mjs. Edit src/, not this file. -->`);

  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(OUT, html);
  const size = (await stat(OUT)).size;
  const ms = Math.round(performance.now() - started);
  console.log(
    `✓ dist/pdf-editor.html  ${(size / 1024).toFixed(1)} KB  ` +
      `(${Object.keys(modules).length} modules, ${cssFiles.length} stylesheets, ${ms} ms)`,
  );
}

async function replaceAsync(str, re, fn) {
  const parts = [];
  let last = 0;
  for (const m of str.matchAll(re)) {
    parts.push(str.slice(last, m.index), await fn(...m));
    last = m.index + m[0].length;
  }
  parts.push(str.slice(last));
  return parts.join('');
}

await main();
