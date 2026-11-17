# Progress

Memory between sessions. Statuses: `todo` · `in progress` · `awaiting approval` · `approved`.

| Milestone | Name | Status |
|---|---|---|
| M0 | Scaffold, build and test harness | approved |
| M1 | Core viewer | approved |
| M2 | App shell, tabs, home screen | in progress |
| M3 | Find and navigation | todo |
| M4 | Document model, undo/redo, save, autosave | todo |
| M5 | Organize pages | todo |
| M6 | Combine and split | todo |
| M7 | Properties, attachments, layers | todo |
| M8 | Comments and annotations | todo |
| M9 | Forms and signatures | todo |
| M10 | Protect, redact, print | todo |
| M11 | Scan & OCR | todo |
| M12 | Accessibility checker, polish and final audit | todo |

## Environment notes (for any session)

- Commands: `node build.mjs`, `node tests/make-fixtures.mjs`, `npx playwright test` (or `npm test` = build + test).
- The cloud sandbox blocks jsDelivr (and other CDNs); npm works. Tests therefore serve the pinned
  CDN URLs from `node_modules` via Playwright routing (`tests/e2e/helpers.mjs`). The built app
  still loads from jsDelivr for real users. Keep `package.json` devDependency versions == `src/core/libs.config.js`.
- Playwright: `@playwright/test@1.63.0` matches the preinstalled Chromium; don't `playwright install`.
- Encrypted fixture is made with pikepdf (`pip install pikepdf`) because qpdf CLI isn't installable here.
- Develop on branch `claude/new-session-rap1ml`.

## Notes

### M0 — Scaffold, build and test harness (approved)
- **Bundling:** `build.mjs` embeds each ES module verbatim as a string (JSON script block), rewrites
  relative imports to `@app/<path>`, and a bootstrap creates Blob URLs + a runtime import map, then
  imports `@app/main.js`. Real ESM semantics; `src/` also runs unbundled via `npm run dev`.
  Build fails on unresolved imports, bare npm specifiers, or version mismatch (`src/core/version.js` vs package.json).
- **Libraries pinned** in `src/core/libs.config.js`: pdfjs-dist 6.5.438, pdf-lib 1.17.1, fflate 0.8.3,
  tesseract.js 7.0.0. Lazy loaders in `src/core/libs.js`.
- **pdf.js 6 API notes:** `getFieldObjects()` and `getAttachments()` return `Map`s. Fields made by
  pdf-lib have a parent entry (type "") plus widget kids — read the type from the widget.
- **Registry:** `src/tools/registry.js` (defineTool / implementTool / runTool / listTools);
  `src/tools/catalogue.js` defines all 28 tools (8 categories) as `soon`, each tagged with the
  milestone that builds it. Later milestones: create `src/tools/<id>.js` calling `implementTool`.
- **Theme:** tokens in `src/styles/tokens.css` (`[data-theme]` on `<html>`); inline head script applies
  the saved/system theme before paint; `ui/theme.js` handles toggle + persistence (`pdfeditor.theme`).
- **i18n:** `src/i18n/en.js` + `t(key, params)`.
- **Home (temporary, M0):** drop zone with disabled "Open PDF…" (Coming soon), recommended tools,
  full catalogue with badges, privacy note. M2 builds the real home screen.
- **Fixtures:** `corrupted.pdf` uses a wrong generation number on page 3's object — a dangling page-tree
  ref makes pdf.js truncate the page count, which wouldn't test "render the pages that work".
  `truncated.pdf` can't be opened at all (InvalidPDFException) → the app must show an error, not go blank.
- **Tests:** 17 (6 e2e smoke incl. CDN library load + screenshots, 11 fixture checks). One unexplained
  failure of the theme-persistence test seen once; not reproducible in 166 reruns. Watch it.

### M1 — Core viewer (approved)
- **Files:** `view/pdfjs.js` (lib + worker + open/password), `view/layout.js` (pure layout),
  `view/viewer.js` (scroll/zoom/virtualization/scheduler/navigation), `view/page-view.js` (canvas,
  tiles, text + link layers, error tile), `ui/app.js` (controller + commands + drag/drop + read
  mode/fullscreen), `ui/statusbar.js`, `ui/menu.js`, `ui/dialog.js`, `ui/toast.js`, `ui/commands.js`,
  `tools/read-mode.js` (first tool marked ready), `styles/pdfjs-layers.css` (verbatim pdf.js CSS).
- **Worker:** classic Blob worker built from the fetched pdf.worker.min.mjs (module Blob workers fail
  on file:// in Chrome). `useWorkerFetch:false` so fonts/cmaps/wasm load on the main thread (also lets
  Playwright routing serve them). `disableWorkerRendering:true`.
- **pdf.js 6 gotchas:** no `PDFDocumentProxy.destroy()` → use `doc.loadingTask.destroy()`;
  `getViewport({rotation})` is absolute → add page `/Rotate` to view rotation; text layer scales via
  CSS vars `--scale-factor`/`--total-scale-factor` on an ancestor (set on `.page`), so zoom needs no rebuild.
- **Zoom:** 100% = 96/72 px per pt. Modes `auto` (fit width ≤125%, fit page for landscape),
  `fit-width`, `fit-page`, number. ⌘=/⌘-/⌘0, ctrl+wheel (pinch = small deltas → proportional),
  Safari gesture events. Re-render held 140 ms after the last zoom change.
- **Tiles:** zoom > 3 or > 16 MP → low-res backdrop (≤4 MP) + 1024 px device tiles, visible ±½ tile.
- **Commands registry** (`ui/commands.js`) is ready for M2 menus/palette; shortcuts dispatched globally,
  skipped while a dialog/menu is open. `kbd-nav` class on <html> shows the viewer focus ring only for keyboard users.
- **Tests:** `viewer.spec.mjs` (17), `performance.spec.mjs` (500 pages: open ≈350 ms, no main-thread
  stall > 50 ms while scrolling + zooming; canvases bounded). Long Tasks API isn't reported in headless
  Chromium → heartbeat-timer stall detector with a self-check. Ctrl+O test asserts the picker input
  is clicked (Playwright filechooser event races under parallel load).
- **Known limitations:** see README. No tabs/menus yet (M2). Page labels in M3.
