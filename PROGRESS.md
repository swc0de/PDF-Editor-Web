# Progress

Memory between sessions. Statuses: `todo` · `in progress` · `awaiting approval` · `approved`.

| Milestone | Name | Status |
|---|---|---|
| M0 | Scaffold, build and test harness | approved |
| M1 | Core viewer | approved |
| M2 | App shell, tabs, home screen | approved |
| M3 | Find and navigation | approved |
| M4 | Document model, undo/redo, save, autosave | awaiting approval |
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

### M2 — App shell, tabs, home screen (approved)
- **Structure:** `ui/app.js` (controller), `ui/doc-tab.js` (per-document tab), `ui/tabs.js` (tablist),
  `ui/menubar.js` + `ui/app-menus.js`, `ui/app-commands.js` (all commands), `ui/palette.js` + `ui/fuzzy.js`,
  `ui/tools-panel.js`, `ui/side-panel.js` + `ui/panels.js` (panel registry: `implementPanel(id, {render})`
  — M3 Pages/Bookmarks, M7 Layers/Attachments/Properties, M8 Comments, M9 Fields), `ui/splitter.js`,
  `ui/preferences.js`, `ui/about.js` (About + Keyboard shortcuts), `core/settings.js`, `core/idb.js`
  (stores: recents, recentFiles, autosave, signatures — created up front), `core/recents.js`.
- **Tabs:** hidden tabs keep their viewer (display:none); `Viewer.isHidden` guards update/resize.
  Selection saved/restored on switch. Opening identical bytes (SHA-256 content id) switches to the
  existing tab. Closed-tab stack (10) keeps bytes + password + view state for reopen.
  `DocTab.setDirty()` drives the dot; closing a dirty tab asks (M4 will add Save to that dialog).
- **Commands:** shortcuts in text inputs only fire for Mod/Ctrl/Alt/function-key combos.
  `hidden: true` keeps a command out of the palette. Palette ids: commands by id, tools as `tool:<id>`.
  Recent palette picks in localStorage `pdfeditor.palette.recent`.
- **Settings keys:** `pdfeditor.setting.{toolsSide,author,defaultZoom,defaultLayout}`, `pdfeditor.theme`
  (absent = follow system), `pdfeditor.arrangement` ({tools:{visible,width}, side:{visible,width,panel}}).
- **Tests:** `shell.spec.mjs` (15): tabs (state per tab, close/others/reopen/Ctrl+W, dirty guard,
  dedupe, arrows, wheel scroll), panels (F4/Shift+F4, rail, empty states, drag + keyboard resize,
  persistence, reset), palette (fuzzy/id/arrows/Enter/recent), preferences persistence, recents
  (reload, open, remove, clear), menu keyboard nav, About/shortcuts. Total suite: 51.
- **Known limits:** Chrome reserves Ctrl+W / Ctrl+Shift+T / Ctrl+PageUp/Down (documented in README).

### M3 — Find and navigation (approved)
- **Find:** `view/text-index.js` (per-page `{text, items:[{start,len}]}`, item k ↔ pdf.js
  `TextLayer.textDivs[k]`; EOL → one space) + `view/find-controller.js` (per tab, lazily `tab.find`)
  + `ui/find-bar.js` (one bar for the app, rebinds on tab switch). Highlight spans need class
  `appended` (pdf.js CSS makes text-layer spans absolute otherwise). `navigation.css` must load after
  `pdfjs-layers.css`. Viewer emits `textlayer` {index} when a page's text layer is ready.
- **Commands:** find.open (Mod+F), find.next (Mod+G, F3), find.prev (Mod+Shift+G, Shift+F3),
  find.close (Esc, after view.exitReadMode), go.back/forward (Alt+←/→; arrow shortcuts never fire in text fields).
- **Viewer:** `labels` (ignored when they're just 1..n), `pageLabel(i)`, `resolvePageInput(text)`
  (label first, then number), `navigate(n)` (pushes history), `back()/forward()`, `history` (NavHistory).
  `goToDest` pushes history.
- **Panels:** `ui/panels/pages-panel.js` (thumbs rendered once at 180 px × min(dpr,2), PNG blob URLs
  cached on `tab.thumbs`, cleared on rotation; slider pref `pdfeditor.thumbSize`), `ui/panels/bookmarks-panel.js`
  (`tab.outlinePromise`; PDF count>0 = open). Panels' render gets `(container, tab, app)`. DocTab fires `destroy`.
- **Tools ready:** read-mode, find, bookmarks, page-thumbnails.
- **Tests:** `navigation.spec.mjs` (13). Suite total 64.
- **Limitations:** no ligature/diacritic/hyphen normalization in search (README).

### M4 — Document model, undo/redo, save, autosave (awaiting approval)
- **Flow:** command → `app.edit(tab, op, args, label)` → `DocumentModel.execute` (core/document-model.js,
  serial queue) → `applyOp` (core/pdf-worker.js) → worker (core/worker/worker-main.js; pdf-lib UMD fetched
  on main thread and prepended; classic Blob worker) → new bytes → `UndoHistory.push` → `onChange` =
  `DocTab.applyChange` (pdf.js reopens bytes; `Viewer.replaceDocument(doc, {affected, structural})`
  re-renders only affected pages, rebuilds views if page count changes; zoom kept as is).
- **Ops:** `core/ops/*.js`, self-contained `function op(PDFLib, doc, args) → { affected }`, registered in
  `core/ops/index.js` (serialised via toString). M4 op: `rotatePages({pages, delta})`.
- **Undo:** snapshot per step (`core/undo-history.js`), limits 100 steps / 512 MB; `moveTo` returns the union
  of affected pages crossed. `model.savedEntry` identity → dirty. Worker caches pdf-lib doc by version id;
  replies `needBytes` when stale (after undo) and the client resends the snapshot.
- **Commands:** file.save (Mod+S), file.saveAs (Mod+Shift+S), edit.undo (Mod+Z), edit.redo (Mod+Shift+Z, Mod+Y)
  — `inInput: false` keeps native undo in text fields; `getLabel()` gives "Undo Rotate page 3";
  page.rotateRight/Left. Panel `history` (Undo History) + tool `undo-history` ready.
- **Open with handles:** `pickFile()` uses showOpenFilePicker when present (tests stub it); drag-drop uses
  `getAsFileSystemHandle`; recents store the handle. Save writes back via handle else downloads; Save As
  uses showSaveFilePicker (suggested `-edited`) else downloads `-edited`.
- **Autosave:** 60 s interval + visibilitychange/pagehide; IDB `autosave` keyed by `tab.autosaveId`
  (= contentId, or the record id for recovered docs). Deleted on save, on clean (undo to saved), on close.
  Home shows "Recover unsaved changes" (records not open in a tab). `app.autosave.runNow()` for tests.
- **Guards:** close dirty tab → Save / Don't save / Cancel; `beforeunload` when any tab dirty.
  Encrypted docs (needed a password) are read-only; pdf-lib EncryptedPDFError also flips read-only.
- **Tests:** `editing.spec.mjs` (10), `tests/unit/i18n.spec.mjs` (missing-string check). Total 76.
  `reloadApp()` helper waits 250 ms before reloading (Chromium localStorage commit race under load).
  Fixed along the way: palette reopen race (closed dialog not yet 'close'd), autosave deletion awaited on save.
