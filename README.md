# PDF Editor

A full-featured PDF editor delivered as **one self-contained HTML file**:
`dist/pdf-editor.html`. Open it in a browser — no server, no install, no
uploads. Everything runs locally; the only network requests are library
downloads from jsDelivr at pinned versions.

> Status: under construction, milestone by milestone. See `PROGRESS.md` for
> where things stand and `MILESTONES.md` for the plan.

## Use it

Open `dist/pdf-editor.html` in a current Chromium, Firefox or Safari
(double-click works; `file://` is supported). The first load needs internet
access to fetch the PDF libraries from the CDN.

## Build

Requires Node 22+. The build itself has **no dependencies**:

```bash
node build.mjs
```

That writes `dist/pdf-editor.html`. Edit files in `src/`, never the output.

For development you can also serve `src/` directly — it's plain ES modules:

```bash
npm install
npm run dev     # http://localhost:8080
```

## Test

```bash
npm install                     # Playwright + the pinned libraries (test-only)
node tests/make-fixtures.mjs    # regenerate the fixture PDFs (committed already)
npm test                        # builds, then runs every test
```

The suite uses the Chromium that ships with Playwright. Screenshots for manual
review are written to `test-results/screenshots/`.

What the harness enforces on **every** end-to-end test (`tests/e2e/helpers.mjs`):

- no `console.error` and no uncaught page errors;
- no network request other than the pinned jsDelivr URLs;
- jsDelivr requests are answered from `node_modules`, so tests run offline and
  deterministically. The installed package version must equal the pinned
  version, or the test fails.

## How the single-file build works

`build.mjs` (≈200 lines, no dependencies):

- **CSS** — every `<link rel="stylesheet">` in `src/index.html` is inlined as a
  `<style>` block.
- **JS** — modules are *not* concatenated (that loses ES module semantics:
  scope, live bindings, cycles). Each `.js` file under `src/` is embedded
  verbatim in a JSON `<script>` block, with relative imports rewritten to bare
  ids (`./ui/home.js` → `@app/ui/home.js`). At startup a ~30-line bootstrap turns
  each module into a Blob URL, installs an **import map** from the `@app/…` ids
  to those URLs, and imports `@app/main.js`. The browser's own module loader
  does the rest, so code runs identically from `src/` in development and from
  the single file.
- The build fails on an import that doesn't resolve, on a bare npm specifier
  (libraries come from the CDN, not npm), and if `src/core/version.js`
  disagrees with `package.json`.
- **Workers** are created from Blob URLs. pdf.js's worker code is downloaded on
  the main thread and started as a *classic* worker, because Chrome refuses
  module workers from Blob URLs on `file://` pages. Its only module syntax (a
  trailing `export {…}` and `import.meta.url` inside the wasm decoders) is
  stripped/substituted first. pdf.js fetches fonts, CMaps and wasm on the main
  thread (`useWorkerFetch: false`).

Requires import maps and module scripts: Chrome/Edge 89+, Firefox 108+,
Safari 16.4+.

## Libraries

All versions are pinned in **one** place, `src/core/libs.config.js` (and
mirrored in `package.json` devDependencies for the tests).

| Library | Version | Used for | License |
|---|---|---|---|
| [pdf.js](https://mozilla.github.io/pdf.js/) (`pdfjs-dist`) | 6.5.438 | rendering, text, search, outline, forms layer | Apache-2.0 |
| [pdf-lib](https://pdf-lib.js.org/) | 1.17.1 | all modification and saving | MIT |
| [fflate](https://github.com/101arrowz/fflate) | 0.8.3 | zipping split outputs | MIT |
| [Tesseract.js](https://tesseract.projectnaptha.com/) | 7.0.0 | OCR (loaded only when OCR opens) | Apache-2.0 |

## Project layout

```
build.mjs              single-file build (no deps)
src/
  index.html           page template
  main.js              entry point
  styles/              CSS; tokens.css holds every theme variable (light + dark)
  core/                document model, undo/redo, pdf-lib ops, persistence, libs
  view/                renderer, viewport, virtualization, tiles
  ui/                  shell, panels, dialogs, palette, menus, icons, theme
  tools/               registry.js, catalogue.js, then one module per tool
  i18n/                every user-facing string (en.js)
tests/
  make-fixtures.mjs    generates tests/fixtures/*.pdf + manifest.json
  e2e/                 Playwright tests against dist/pdf-editor.html
  unit/                Node-side checks (e.g. the fixtures are what we claim)
dist/pdf-editor.html   the deliverable
```

### Viewer (`src/view/`)

- `layout.js` — pure maths: page boxes for continuous / single / two-up (with
  cover) at any zoom and view rotation; visible rows by binary search.
- `viewer.js` — the scroll container. Only visible pages ±2 are rendered;
  pages more than 6 away release their canvases. Placeholders always have the
  right size (page 1's size first, then every page's real size fetched in the
  background). Zoom keeps the point under the cursor (or the centre) still; the
  sharp re-render waits until zooming pauses. A small scheduler renders at most
  two pages at once, visible pages first, and cancels renders that went stale.
- `page-view.js` — one page: a canvas at CSS size × devicePixelRatio; above
  300% zoom (or past 16 MP) a low-resolution backdrop plus 1024-px tiles for the
  visible area only. Text layer (pdf.js `TextLayer`) for selection, a link layer
  for internal/external links, and an error tile when a page can't be loaded.

### Tool registry

`tools/catalogue.js` defines every planned tool (id, category, icon, shortcut,
milestone) as **Coming soon**, so the catalogue is complete from day one. When
a tool is built, its own module calls `implementTool(id, run)`, which marks it
ready. The UI reads only from the registry, and `runTool()` refuses tools that
aren't built — nothing is faked.

## Test fixtures

Generated by `tests/make-fixtures.mjs` with pdf-lib (deterministic dates); facts
the tests rely on are in `tests/fixtures/manifest.json`.

| File | What it exercises |
|---|---|
| `multipage.pdf` | 12 pages, known search words |
| `mixed-sizes.pdf` | A4, Letter, A5 landscape, Legal, square, a `/Rotate 90` page |
| `outline.pdf` | nested outline (bookmarks) |
| `page-labels.pdf` | labels i–iv, 1–4, A-1, A-2 |
| `forms.pdf` | text, multiline, checkbox, radio, dropdown, list box, button, signature |
| `annotations.pdf` | note, highlight, square, circle, arrow, ink, free text, internal + external links |
| `attachment.pdf` | a text file and a PDF embedded as attachments |
| `layers.pdf` | two optional content groups, one hidden by default |
| `corrupted.pdf` | page 3 can't be loaded; pages 1–2 and 4–5 can |
| `truncated.pdf` | cut off at 60%: can't be opened at all |
| `encrypted.pdf` | AES-256, user password `secret` |
| `large.pdf` | 500 pages (every 50th landscape) for performance tests |

`encrypted.pdf` needs an encryption tool when generating: the `qpdf` CLI, or
Python's `pikepdf` (`pip install pikepdf`, which bundles qpdf). Without either
it's skipped and so are its tests.

## Known limitations

- Only Chromium is covered by the automated tests. Safari trackpad pinch uses
  `gesture*` events and is untested.
- Links: URL links and destinations work; PDF named actions and JavaScript
  actions are not executed.
- Text selection follows the order of text in the PDF's content stream (what
  pdf.js provides), which is reading order for most but not all files.
- Single-page layout flips pages with PageUp/PageDown, ←/→ and the status bar,
  not by scrolling past the end of a page.

## Privacy

No analytics, no uploads, no server. Files are read from your disk into the
browser tab and never leave the device.

Inspired by the open-source PdfCraft project (MIT/Apache-2.0).
