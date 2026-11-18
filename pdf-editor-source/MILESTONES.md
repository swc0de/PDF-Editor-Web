# PDF Editor — milestone prompts for Claude Code

How to use this:
1. Put `CLAUDE.md` and this file in an empty project folder.
2. Start Claude Code there and say: **"Start the project."** It runs `git init`, creates `PROGRESS.md`, and begins M0.
3. After each milestone it stops and asks for approval. Open `pdf-editor.html` (repository root), try it with a few real PDFs, then reply **approved** or say what to change.
4. Optional: when it's waiting for approval, you can run `/clear` and then say **approved**. It picks up from `PROGRESS.md` with a fresh context, which tends to give better results on later milestones.

The prompts below are what Claude Code follows for each milestone. You don't need to paste them yourself.

Every prompt ends with the same "Definition of done", repeated in each so you can copy a prompt on its own.

---

## M0 — Scaffold, build and test harness

```
Read CLAUDE.md. Milestone M0: set up the project skeleton only.

- Create the src/ folder structure from CLAUDE.md (core/, view/, ui/, tools/, i18n/) with an index.html template, a base CSS file with all theme tokens as CSS custom properties (light + dark), and a main.js entry.
- Write build.mjs (Node, zero deps): it inlines CSS and JS modules into a single HTML file (now `pdf-editor.html` at the repository root), which must work from file://. Choose and document how ES modules are bundled (e.g., a simple concatenating bundler or an import-map + inline module approach). Pin library CDN versions in one config file.
- Create the tool registry (id, label, category, shortcut, status, run) and register EVERY tool from CLAUDE.md as status "soon" so the catalogue is complete from day one.
- Write tests/make-fixtures.mjs to generate all the fixture PDFs listed in CLAUDE.md.
- Set up Playwright with one smoke test: the page loads, there are no console errors, and the app title is "PDF Editor".
- Add a README with how to build and test.

Definition of done: node build.mjs succeeds, all tests pass, no console errors, screenshots reviewed, git commit with a clear message. Then summarize what was built and any decisions I should know about.
```

## M1 — Core viewer

```
Read CLAUDE.md. Milestone M1: a rock-solid viewer for a single document (no tabs yet).

- Open via button, drag-and-drop and ⌘O. Load pdf.js with its worker from a Blob URL.
- Virtualized continuous scrolling: render only visible pages ±2, with placeholders at the correct size for the rest (mixed page sizes must work).
- Sharp rendering at devicePixelRatio × zoom. Above 300% zoom, switch to tiled rendering of visible tiles only. Cancel stale render tasks.
- Zoom: ⌘= / ⌘- / ⌘0, ctrl+wheel/pinch zoom anchored at the cursor, fit width, fit page.
- Layouts: continuous, single page, two-up (with a cover-page option), view rotation ±90°, full screen, and Read mode (hides all chrome; Esc exits).
- Text layer for selection in reading order; working links (internal jumps; external links open after a confirm).
- Password-protected PDFs: password prompt with retry.
- Damaged files: the pages that work render; failing pages show an error tile.
- Status bar: page input / total, zoom controls, layout picker.

Add e2e tests: render the fixtures, zoom, layout switching, page navigation, the password flow, the corrupted file. Also add a performance test: a generated 500-page PDF must open and scroll without long tasks over 200ms.

Definition of done: node build.mjs succeeds, all tests pass, no console errors, screenshots reviewed in light and dark, git commit. Summarize what was built and any known limitations.
```

## M2 — App shell, tabs, home screen

```
Read CLAUDE.md. Milestone M2: build the full application shell around the viewer.

- Top bar with the File/Edit/View/Tools/Help menus (keyboard navigable, showing shortcuts), the tab strip (unsaved dot, close, horizontal wheel scrolling, right-click menu: Close / Close others / Reopen closed tab, ⌘W, ⇧⌘T). Each tab keeps its own zoom, scroll, layout and selection.
- Left tools panel driven by the tool registry, grouped by category, "Coming soon" badges, resizable 240–520px, Shift+F4, and a left/right position preference.
- Right rail + one side panel, resizable 260–520px by dragging, F4. Create all the panel shells now (Pages, Bookmarks, Layers, Fields, Comments, Attachments, Document Properties) with empty states.
- Home screen: drop zone, recommended tools, recent files (store the file bytes and metadata in IndexedDB; open with one click; remove from recents), privacy note, full catalogue.
- Command palette (⌘K): fuzzy search over all commands and tools by label or id, shortcuts shown, arrow-key navigation, recent commands first.
- Preferences dialog (theme, tools panel side, author name for comments, default zoom/layout), saved in localStorage.
- Theme toggle with prefers-color-scheme on first run.
- Panel sizes and visibility persist; "View → Reset arrangement" restores the defaults.
- Help → About dialog as specified in CLAUDE.md.

Add e2e tests for tabs, panels, the palette, preferences persistence and recents.

Definition of done: node build.mjs succeeds, all tests pass, no console errors, screenshots reviewed in light and dark, git commit. Summarize, and tell me anything you'd change about the layout.
```

## M3 — Find and navigation

```
Read CLAUDE.md. Milestone M3: Find and navigation.

- Find bar (⌘F): search as you type across the whole document (index the text incrementally in the background), highlight all matches, mark the current match, show an "n of m" counter, ⌘G / ⇧⌘G, match case, whole word, Esc to close.
- Pages panel: lazy thumbnails (IntersectionObserver), a 50–150% size slider, current page highlighted, click to jump.
- Bookmarks panel: the outline tree with expand/collapse, click to jump, and search that keeps the ancestors of matches visible.
- Page labels shown in the status bar and the thumbnails; the page input accepts labels (e.g., "iv").
- History: back/forward after link jumps (Alt+← / Alt+→).

Add e2e tests for search counts on the fixtures, outline navigation and labels.

Definition of done: node build.mjs succeeds, all tests pass, no console errors, screenshots reviewed in light and dark, git commit. Summarize.
```

## M4 — Document model, undo/redo, save, autosave

```
Read CLAUDE.md. Milestone M4: the editing foundation. Nothing visible gets edited yet besides one test operation, but everything later depends on this, so make it robust.

- Document model in core/: original bytes + a pdf-lib document held in a Web Worker (created from a Blob URL). The main thread sends named commands; the worker applies them and returns updated bytes/info. The viewer reloads only the affected pages where possible.
- A command/undo system: each step has a name, do/undo (or snapshot-based undo if simpler and memory-safe — explain your choice), and there are history limits. The Edit menu shows "Undo <step name>" / "Redo <step name>". An Undo History panel lets you click to jump to any step. Undo still works after saving.
- The dirty state drives the tab dot.
- Save (⌘S): use the File System Access API to write back to the original file when available, otherwise download. Save As (⇧⌘S) uses the "-edited" suffix. Keep metadata intact.
- Autosave the working state to IndexedDB every 60s. On launch, offer "Recover unsaved changes" per document.
- Guards: closing a tab with unsaved changes opens a dialog (Save / Don't save / Cancel), and there is a beforeunload guard.
- Implement ONE real command end-to-end to prove the pipeline: "Rotate current page 90°".

Add e2e tests: rotate → undo → redo → save → reopen gives the right result; autosave recovery after a page reload; the dirty guards.

Definition of done: node build.mjs succeeds, all tests pass, no console errors, screenshots reviewed, git commit. Summarize the architecture so I can sanity-check it.
```

## M5 — Organize pages

```
Read CLAUDE.md. Milestone M5: the Organize pages tool, built on the M4 command system.

- A full-screen grid of thumbnails (virtualized for big documents) with selection by click, ⌘-click and ⇧-click range, plus select all / invert / odd / even.
- Actions: rotate ±90°, delete, duplicate, insert a blank page before/after (sized like the neighbour, or A4/Letter), insert pages from another PDF at a position (with a page-range picker), extract the selection to a new tab, and drag-and-drop reordering with a drop indicator (multi-select drag works).
- Keyboard: Delete, ⌘D duplicate, ⌘←/→ move, ⌘A.
- Every action is ONE named undo step (e.g., "Delete 3 pages").
- Preserve outlines and links as far as pdf-lib allows; document any losses in the README.

Change this tool's status in the registry to ready. Add e2e tests covering every action plus undo.

Definition of done: node build.mjs succeeds, all tests pass, no console errors, screenshots reviewed in light and dark, git commit. Summarize.
```

## M6 — Combine and split

```
Read CLAUDE.md. Milestone M6: Combine & split tools.

- Combine: a dialog with a reorderable file list (add from disk or from open tabs), an optional page range per file, and the option "Add a bookmark for each file" (one nested outline entry per source, with the source's own outline nested beneath it when possible). The result opens in a new tab.
- Extract pages: by range string ("1-3, 7, 10-") or by the current selection.
- Split: every N pages, at chosen page numbers, or by top-level bookmarks. Name the outputs sensibly and download them as one .zip (fflate).
- Carry over form fields, links and metadata where pdf-lib allows.
- Run the heavy work in the worker with a progress indicator and a cancel button.

Mark these tools ready. Add e2e tests that check page counts and outline entries of the outputs.

Definition of done: node build.mjs succeeds, all tests pass, no console errors, screenshots reviewed, git commit. Summarize.
```

## M7 — Properties, attachments, layers

```
Read CLAUDE.md. Milestone M7: the information panels.

- Document Properties panel: edit title, author, subject and keywords (as an undoable step). Read-only info: producer, creator, created/modified dates, PDF version, page count, page sizes, fonts with embedding status, tagged yes/no, field count, layer count, attachments, and encryption/permission info.
- Attachments panel: list (name, size, description), open in a new tab if it's a PDF, otherwise save; add an attachment; remove one (undoable).
- Layers panel: list the optional content groups with visibility toggles that re-render instantly; respect the default visibility.

Mark these tools ready. Add e2e tests.

Definition of done: node build.mjs succeeds, all tests pass, no console errors, screenshots reviewed in light and dark, git commit. Summarize.
```

## M8 — Comments and annotations

```
Read CLAUDE.md. Milestone M8: commenting.

- Annotation tools in a contextual toolbar: highlight, underline and strike-out (from text selection); rectangle, ellipse, line/arrow, freehand ink, text box and sticky note. Each has colour/opacity/stroke-width controls, and the last-used settings are remembered.
- Select, move, resize and delete annotations; every change is an undo step.
- Comments panel: a list grouped by page with threaded replies, the author (from Preferences), timestamps, resolve, delete, filter (by type/author/resolved) and jump-to.
- Show existing annotations from the file and let them be edited where possible.
- On save, write real PDF annotation objects (with appearance streams) via pdf-lib so Acrobat, Preview and browsers show them. Verify by re-opening the saved file in a new tab and checking pdf.js reads them.

Mark these tools ready. Add e2e tests that create each type, save, reopen and assert.

Definition of done: node build.mjs succeeds, all tests pass, no console errors, screenshots reviewed in light and dark, git commit. Summarize.
```

## M9 — Forms and signatures

```
Read CLAUDE.md. Milestone M9: Forms.

- Fill AcroForm fields of all kinds (text, multiline, checkbox, radio, combo/list) through the pdf.js annotation layer, then write the values with pdf-lib on save (update the appearances so other viewers show them). A "Highlight fields" toggle.
- Fields panel: every field with name, type and value; click to jump/focus; tab order works.
- Signatures: a dialog with draw / type (a few script-style system fonts) / image upload. Saved signatures go in IndexedDB. Place a signature in a signature field or anywhere on a page, then move/resize it. Label this honestly in the UI as a visual signature, not a cryptographic one.
- Form authoring: draw a rectangle to add a text field, checkbox, dropdown (with an options editor) or signature field. Field properties: name, required, default value. All of these are undo steps.
- Flatten form (optional action, undoable).

Mark these tools ready. Add e2e tests: fill → save → reopen keeps the values; author a field → save → it's fillable.

Definition of done: node build.mjs succeeds, all tests pass, no console errors, screenshots reviewed in light and dark, git commit. Summarize.
```

## M10 — Protect, redact, print

```
Read CLAUDE.md. Milestone M10: Protect and Everywhere tools.

- Redaction: mark areas by drawing rectangles or from search results ("Mark all matches"). Marks are reviewable and removable. "Apply redactions" rasterizes the affected pages at 200 dpi with black boxes burned in, replaces them, and shows a clear warning first that those pages lose selectable text. This is an undo step.
- Sanitize: checkboxes for removing metadata, JavaScript/actions, attachments, hidden layers and comments.
- Password protection: research whether a maintained qpdf WASM (or other) build can be loaded from a CDN and run in a Blob worker. If so, implement adding/removing user and owner passwords and setting permissions (AES-256 by default). If not, keep the tool "Coming soon" and explain why in the README. Do not fake it.
- Print (⌘P): render pages at a chosen dpi (150/300) with a page range into a hidden iframe and print, with progress shown.

Add e2e tests: after redaction the redacted text is not extractable; sanitize removes the selected items.

Definition of done: node build.mjs succeeds, all tests pass, no console errors, screenshots reviewed, git commit. Summarize, including the outcome on encryption.
```

## M11 — Scan & OCR

```
Read CLAUDE.md. Milestone M11: OCR with Tesseract.js (lazy-loaded).

- The OCR dialog: current page / range / all pages, a language picker (English default; others downloaded when chosen), preprocessing checkboxes (auto-rotate, deskew, denoise, binarize, done on a canvas), progress per page, and cancel.
- OCR Verify screen: the page image with recognized words overlaid and coloured by confidence (green/amber/red). Click a word to correct it, with a user dictionary in localStorage. Draw a box to re-OCR a region, or re-OCR the whole page.
- "Apply" adds an invisible text layer positioned over the words via pdf-lib, making the document searchable. It's one undo step.
- Run it in workers; keep the UI responsive.

Generate a scanned-image fixture for tests. Add e2e tests: OCR, then the find bar locates a known word.

Definition of done: node build.mjs succeeds, all tests pass, no console errors, screenshots reviewed in light and dark, git commit. Summarize.
```

## M12 — Accessibility checker, polish and final audit

```
Read CLAUDE.md. Milestone M12: finish and harden.

- Accessibility Checker tool: report tagged status, document title and language, figures without alt text where detectable, unnamed fields and missing bookmarks in long documents. Show an issue list with page links.
- Audit our own UI: keyboard-only walkthrough of every tool, ARIA roles, focus rings, contrast in both themes (fix anything below WCAG AA).
- i18n: confirm there are no hard-coded user-facing strings left.
- Performance: profile with a 500-page and a 50 MB PDF; fix long tasks and memory growth (release canvases, cap caches).
- Visual polish pass: consistent spacing, icon sizes, empty states, loading states, error toasts. Review screenshots of every screen in light and dark, and fix inconsistencies.
- Remove any remaining "Coming soon" for tools that are now built; list honestly what's still unbuilt.
- Final check: open pdf-editor.html from file:// in a fresh profile and make sure everything works.
- Update the README with the feature list, limitations and library licenses.

Definition of done: node build.mjs succeeds, all tests pass, no console errors, git commit and tag v1.0.0. Give me a final report: what works, known limitations, and suggested next steps.
```
