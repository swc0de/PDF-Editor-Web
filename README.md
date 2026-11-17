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
| [qpdf](https://qpdf.sourceforge.io/) 12.2.0 as WebAssembly ([`@neslinesli93/qpdf-wasm`](https://github.com/neslinesli93/qpdf-wasm)) | 0.3.1 | password protection: AES-256 encryption, permissions, removing protection (loaded only when used) | Apache-2.0 (qpdf), ISC (build) |

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

### Editing: document model, undo, save (`src/core/`)

```
 UI command ──► DocumentModel.execute(op, args, "Rotate page 3")      (one queue per document)
                   │  applyOp ──► pdf-lib worker: load (cached) → op → save ──► new bytes
                   │  UndoHistory.push({label, bytes, affected pages})
                   └► DocTab.applyChange: pdf.js opens the new bytes,
                      Viewer.replaceDocument re-renders only the affected pages
```

- **Worker** (`core/pdf-worker.js`, `core/worker/worker-main.js`): a classic
  Blob-URL worker holding pdf-lib (its UMD build is fetched on the main thread
  and prepended). Ops live in `core/ops/*.js` as self-contained functions that
  are serialised into the worker. The worker caches each document's pdf-lib
  object at a version id, so consecutive edits don't re-parse the file; after
  an undo the main thread sends the snapshot bytes instead.
- **Undo is snapshot-based** (`core/undo-history.js`): each step stores the
  whole document after it. Undo/redo/jump just switch snapshots. This is exact
  for every operation — including ones with no cheap inverse (redaction,
  flattening, OCR) — and can't drift the way paired do/undo code can. pdf-lib
  rewrites the file on every save anyway, so snapshots cost nothing extra to
  produce; the cost is memory, capped at 100 steps / 512 MB (oldest dropped
  first, and the Undo History panel says so).
- **Saving** (`ui/save.js`): Save writes back through a File System Access
  handle when the file was opened with one (Chromium: open dialog,
  drag-and-drop, recent files), else downloads. Save As uses the
  `name-edited.pdf` suggestion. pdf-lib loads with `updateMetadata: false`, so
  title, author, dates and producer are kept as they were.
- **Autosave** (`core/autosave.js`): every 60 s (and when the page is hidden)
  dirty documents are written to IndexedDB; the next launch offers *Recover* /
  *Discard* on the home screen. Closing a dirty tab asks Save / Don't save /
  Cancel; leaving the page with unsaved work triggers the browser's prompt.
- Password-protected PDFs open read-only (pdf-lib can't edit encrypted files)
  until their protection is removed (Protect → Password protection, M10).

### Organize pages (`src/ui/organize/`, `src/core/ops/page-ops.js`)

A full-viewport grid over the document: windowed (only rows near the view
exist in the DOM), thumbnails cached per page object so reordering doesn't
re-render them, click / Ctrl-click / Shift-click selection plus Select all /
none / invert / odd / even, pointer drag-and-drop with a drop indicator and
auto-scroll, and keyboard control (arrows, Shift+arrows, Delete, Ctrl+D,
Ctrl+←/→, Ctrl+A, Enter, Esc). Rotate, delete, duplicate, insert blank
(neighbour size, A4, Letter), insert pages from another PDF (with a page
range and position) and move are each **one** named undo step; "Extract to
new tab" creates a new, unsaved document.

**What survives page operations** (pdf-lib works on the page objects
themselves, so most links stay intact):

| Operation | Bookmarks & links | Other |
|---|---|---|
| Move, rotate | Follow their pages (same page objects) | — |
| Delete | Bookmarks to deleted pages are removed (a parent keeps its children); links *to* deleted pages from other pages remain but go nowhere | Form fields that only lived on deleted pages are removed |
| Duplicate | Copies keep their own links; bookmarks still point at the original | Form fields on a duplicated page are copied as widgets but aren't separate fields |
| Insert from PDF | Only the pages come over; the other file's bookmarks aren't imported | Its form fields, attachments and page labels aren't imported |
| Extract to new tab | Pages only (bookmarks aren't carried over) | Form fields and page labels aren't carried over |

Page labels are stored as ranges by position, so after reordering they label
positions, not the pages they used to.

### Combine, split, extract (`src/ui/combine/`, `src/core/ops/jobs.js`)

These run as **jobs** in their own disposable worker (`core/jobs.js`): it
reports progress as it goes, and *Cancel* simply terminates it — instantly,
without touching the editing worker. The job worker bundles pdf-lib and fflate
(for the .zip). Shared, serialisable helpers in `core/ops/pdf-helpers.js` read
and write outlines, re-point links and carry form fields.

- **Combine:** files from disk or open tabs (including their unsaved edits),
  reorder by dragging or with ↑/↓, a page range per file, and *Add a bookmark
  for each file* (each file's own bookmarks nested beneath it; without the
  option they're kept at the top level). Opens in a new, unsaved tab.
- **Extract pages:** a range (`1-3, 7, 10-`) or the organizer's selection →
  new tab.
- **Split:** every N pages, before chosen pages, or at each top-level bookmark.
  Parts are named `name-01-pages-1-5.pdf` / `name-02-part-one.pdf` and
  downloaded together as `name-split.zip`.

**Carried over:** form fields (clashing names get `_2`, `_3`…), links between
pages that are included, the bookmarks of included pages, and the first file's
title/author/subject/keywords/language. **Not carried over:** page labels,
attachments and named destinations; links to pages that weren't included lose
their target.

### Information panels (`src/ui/panels/`)

- **Document Properties:** title, author, subject and keywords are editable
  (*Apply* = one undo step). Read-only: file name and size, PDF version, pages
  and page sizes (named: "A4 portrait × 3"…), producer, application,
  created/modified dates, tagged, language, fast web view, counts of form
  fields / layers / attachments (linking to their panels), fonts with their
  embedding status (inspected by pdf-lib in the worker: `inspectFonts`), and
  encryption with the permission list.
- **Attachments:** name, size, description; PDFs open in a new tab, other
  files are saved; add and remove are undo steps.
- **Layers:** optional content groups in the document's own order and
  nesting, with visibility toggles that redraw immediately (pdf.js
  `optionalContentConfigPromise`), Show all / Hide all / Reset to the
  document's defaults. Layer visibility is a *view* setting: it isn't saved
  into the PDF and isn't an undo step; it survives edits.
- Any encrypted PDF (even one that opens without a password) is read-only,
  because pdf-lib can't rewrite encrypted files.

### Comments and annotations (`src/ui/annotate/`, `src/core/ops/annot-*.js`)

- **Text boxes work like Word** (*Add text* in the Tools panel, or the Text
  box tool): drag a rectangle, type straight into it (text wraps to the box's
  width; the box grows to fit), and format it from the toolbar: font
  (Helvetica / Times / Courier), size, **bold** / *italic* / underline
  (Ctrl+B / I / U), alignment, text colour, fill and border. Click outside or
  press Esc to finish; double-click a text box (or select it and press Enter)
  to edit it in place again. While a box is selected, the formatting controls
  restyle it. The style is kept in the PDF (`/DA`, `/Q`, `/DS`, `/C`, `/BS`,
  plus our own `/PDFEditorStyle`) and drawn into the appearance stream with
  the standard fonts, wrapped the same way the editor shows it.
- **Tools** (contextual "Editing tools" toolbar, docked above the page):
  select · highlight, underline and strike-out (select text with the tool on,
  or select text first and then pick the tool) · sticky note · text box ·
  rectangle · ellipse · line · arrow · freehand drawing. Colour (6 swatches +
  custom), opacity, stroke width and font size; each tool remembers its
  last-used style (preferences). With an annotation selected, the controls
  restyle it.
- **Select / move / resize / delete:** click an annotation with the Select
  tool (sticky notes are clickable any time), drag it, drag one of its 8
  handles, press Delete. Esc cancels a drawing, then deselects, then leaves
  commenting. Every change is one named undo step ("Move Rectangle"…).
- **Real PDF annotations.** Each change runs in the editing worker and writes
  standard annotation objects (Highlight, Underline, StrikeOut, Text,
  FreeText, Square, Circle, Line with /LE arrow, Ink) **with appearance
  streams** (`/AP /N`), author (`/T`, from Preferences → Author name),
  `/Contents`, dates and `/NM`. pdf.js draws them like any other file's
  annotations, so what you see is what's saved. Text-box colour lives in
  `/DA`; `/C` stays the (empty) background as the spec intends.
- **Comments panel:** all comments by page with author and time; edit text,
  reply (a Text annotation with `/IRT`), resolve / reopen (a review-state
  reply: `/StateModel /Review`, `/State /Completed` or `/None`, the latest
  wins), delete (replies, states and popups go with it), filters by type,
  author (incl. reply authors) and status, click to jump and select.
- **Existing annotations** from the file are listed and can be edited: the
  types above get a fresh appearance when moved, resized or restyled; others
  (stamps, polygons…) can be moved, resized and deleted, and keep their own
  appearance, scaled.

### Forms and signatures (`src/view/form-layer.js`, `src/ui/forms/`, `src/core/ops/form-*.js`)

- **Filling.** Pages render in pdf.js "forms" mode and an HTML form layer
  sits on top: text (single/multi-line, password, max length), checkboxes and
  radio buttons (drawn with the PDF's own on/off appearances), dropdowns
  (editable ones get suggestions), list boxes (multi-select). Each committed
  change (leaving a field, Enter, a click) is one undo step ("Fill email"): a
  worker op writes the value with pdf-lib **and regenerates the appearance**
  so other viewers show it too. Values update in place after edits, undo and
  redo, so focus and Tab order survive; Tab continues onto the next page that
  has fields. **Highlight fields** (Fields panel or View menu) tints fillable
  fields and outlines required ones.
- **Fields panel:** every field with name, type, value and page, in tab
  order; click or Enter to jump to it and focus it.
- **Signatures** (Add signature, or a signature field's *Sign* button): draw,
  type (a few script-style system fonts) or upload an image (the white
  background can be made transparent). Signatures can be saved on this device
  (IndexedDB) and reused. A placed signature is a Stamp annotation with the
  image as its appearance, so it can be moved and resized (aspect kept) like
  any annotation, and it appears in Comments as "Signature". The UI says
  plainly that this is a **visual signature, not a cryptographic one**.
- **Prepare form:** draw text fields, checkboxes, dropdowns and signature
  fields; select, move, resize (handles), double-click or *Properties…* for
  name, required, default value (which also becomes the current value) and
  dropdown options; Delete removes the field. All undo steps.
- **Flatten form** draws every field's current appearance into the page and
  removes the fields (one undo step). pdf-lib's own `flatten()`/`removeField()`
  miss separate widget annotations and fields without appearances, so the
  worker uses its own versions.

### Protect: redaction, sanitize, passwords; print (`src/ui/protect/`, `src/core/ops/protect-*.js`, `src/core/qpdf.js`, `src/ui/print.js`)

- **Redact.** Marks are standard `Redact` annotations, drawn as red-outlined
  areas: draw an area, select text, or type a search and **Mark all
  matches** (one mark per match). Marks are reviewed on the page and in the
  Comments panel ("Redaction mark") and removed like any annotation, or all
  at once. **Apply redactions…** warns first (pages, what's lost), then
  renders each marked page at **200 dpi** with black boxes burned into the
  pixels and replaces that page's content with the image (the page object
  stays, so links and bookmarks to it still work). Annotations and form
  fields over a redacted area go too, and a garbage-collection pass deletes
  every object nothing refers to any more, so the old content streams (and
  fonts only they used) aren't left in the saved file. One undo step.
  Search-based marks estimate where characters start and end from browser
  font metrics and are padded by half a character; review them before
  applying.
- **Sanitize** scans first (a dry run of the same op) and lists what it found
  per category: metadata (Info, XMP, application data), JavaScript and
  actions that run code, launch files or send data (ordinary web links stay),
  attachments, hidden layers (content in optional-content groups that are off
  by default is cut out of the content streams, not just hidden), and
  comments (not form fields, links or visual signatures). One undo step;
  unreferenced objects are deleted.
- **Password protection — the encryption outcome.** A maintained WebAssembly
  build of **qpdf 12.2.0** (`@neslinesli93/qpdf-wasm` 0.3.1, on jsDelivr)
  works: it's downloaded only when needed and runs in a classic Blob worker
  (its wasm is handed to the worker as bytes, since this build has no
  `wasmBinary` option and a page Blob URL isn't readable from a worker under
  `file://`). So this is real encryption, not a fake:
  - **Protect** saves a protected *copy* (`name-protected.pdf`) with
    **AES-256** (R6): an open password, and/or an owner password with
    permissions (printing, copying, editing, commenting, forms, page
    assembly). The open document stays editable.
  - **Remove protection** on an encrypted document needs the **owner**
    password (qpdf reports which password was given); the decrypted file
    replaces the document as an undo step and becomes editable. Undo makes it
    protected (read-only) again.
- **Print (⌘P):** all / current / a page range, at 150 or 300 dpi. Pages are
  rendered with pdf.js' print intent (annotations meant for print, form
  values) into images in a hidden iframe, each sheet at its page's own size,
  with progress and Cancel. PDFs that don't allow printing say so.

### Find and navigation

- `view/text-index.js` — indexes each page's text in the background (yielding
  to the UI), keeping every text item's offset so matches map back onto the
  text layer's spans. `view/find-controller.js` searches the index as pages
  arrive ("n of m+" while indexing), highlights matches in rendered text
  layers, and scrolls the current match into view.
- `ui/thumbnails.js` — thumbnails cached per tab, keyed by PDF page object +
  rotation; `ui/canvas-encode.js` encodes them (Chromium's `toBlob()` can stall
  for seconds on a busy page, so it falls back to `toDataURL()`).
- `view/history.js` — back/forward (Alt+← / Alt+→) after link, bookmark,
  thumbnail and page-box jumps.
- `ui/panels/pages-panel.js` (lazy thumbnails, cached per tab as compressed
  images) and `ui/panels/bookmarks-panel.js` (ARIA tree + search).
- Page labels (`i`, `iv`, `A-1`…) show in the status bar and thumbnails; the
  page box accepts a label first, then a page number.

### Shell (`src/ui/`)

- `app.js` — controller: tabs (`doc-tab.js`: one pdf.js document + viewer +
  status bar per tab; hidden tabs stay in the DOM so zoom, scroll, layout and
  rendered pages survive; the text selection is saved and restored), closed-tab
  stack, recents, drag-and-drop, Read mode, full screen.
- `commands.js` + `app-commands.js` — every action as a named command with
  label, shortcut, enabled/checked state. The menu bar (`menubar.js`,
  `app-menus.js`), keyboard shortcuts and the command palette (`palette.js`,
  fuzzy matching in `fuzzy.js`) all use them.
- `tools-panel.js` (from the tool registry), `side-panel.js` + `panels.js`
  (rail + one side panel; panels register a `render()` when they're built),
  `splitter.js` (drag or arrow-key resizing).
- Preferences and the panel arrangement live in localStorage
  (`core/settings.js`); recent files (bytes + first-page thumbnail) in
  IndexedDB (`core/recents.js`, `core/idb.js`), in this browser only.

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
- Browsers reserve some shortcuts for themselves: in Chrome, Ctrl/⌘+W,
  Ctrl/⌘+Shift+T and Ctrl+PageUp/PageDown act on the *browser* tab and never
  reach the page. Use the tab's × / right-click menu or the File menu instead
  (the shortcuts do work where the browser lets them through).
- Recent files keep a copy of each file (up to 12 files, each up to 150 MB) in
  this browser's storage; "Clear recent files" deletes them.

- Search matches the text exactly as stored: ligatures (ﬁ), accents written
  as separate marks, and words hyphenated across lines aren't normalized, so
  e.g. "find" won't match "ﬁnd".

- Password-protected PDFs open read-only; remove their protection (with the
  owner password) to edit them.
- Redaction rasterizes the affected pages (their text becomes an image, 200
  dpi). Text that also appears outside the page content — bookmarks, the
  document title, form field values elsewhere — isn't redacted. Search
  marks are estimates (padded); review them.
- Printing goes through the browser's print dialog; page sizes come from
  CSS named pages (Chromium). Very large documents at 300 dpi take a while
  and use a lot of memory.
- Writing back to the original file needs the File System Access API
  (Chrome/Edge). Elsewhere, Save downloads a copy.

- In Chromium, `localStorage` for `file://` pages can come back empty after a
  reload, so preferences are mirrored to IndexedDB and restored at startup.

- Editing properties updates the PDF's Info dictionary. If a file also has
  XMP metadata, that isn't rewritten, so some apps may still show the old
  values.
- Attachments panel lists document-level embedded files; files attached to
  comments on a page (file-attachment annotations) aren't listed.
- "Embedded subset" is recognised by the standard `ABCDEF+` name prefix; pdf-lib
  doesn't use it, so its subsets show as "Embedded".

- Comments: replies show in the Comments panel, not as pop-ups on the page.
  Text boxes use the standard PDF fonts (Helvetica, Times, Courier; WinAnsi):
  characters outside them are drawn as "?" in the appearance (the text itself
  keeps them). Formatting applies to the whole box, not to single words. Polygon, polyline,
  squiggly and stamp annotations can't be created yet.

- Forms: JavaScript (calculations, validation, formatting, button actions)
  isn't run; push buttons are shown but do nothing. Appearances use Helvetica:
  text outside its character set makes the field fall back to
  `/NeedAppearances` (viewers draw it themselves). XFA-only forms aren't
  supported. Radio groups can't be created in Prepare form yet (existing ones
  can be filled, moved, renamed and deleted).
- Signatures are visual only (an image), not digital signatures. Typed
  signatures use fonts installed on the device, so they look different on
  different systems (the result is saved as an image, so the PDF itself is
  the same everywhere).

## Privacy

No analytics, no uploads, no server. Files are read from your disk into the
browser tab and never leave the device.

Inspired by the open-source PdfCraft project (MIT/Apache-2.0).
