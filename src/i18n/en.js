// English strings. Keys are grouped by area. Placeholders use {name}.
export const en = {
  // App
  'app.name': 'PDF Editor',
  'app.loading': 'Loading…',
  'app.loadError': 'PDF Editor could not start: {message}',
  'app.privacy': 'Your files never leave this device',
  'app.privacyDetail': 'Everything runs locally in your browser. The only network requests are library downloads from a public CDN.',

  // Top bar
  'topbar.theme.toLight': 'Switch to light theme',
  'topbar.theme.toDark': 'Switch to dark theme',

  // Home screen
  'home.drop.title': 'Open a PDF to get started',
  'home.drop.hint': 'Drag a file here, or choose one from your device.',
  'home.drop.open': 'Open PDF…',
  'home.catalogue': 'All tools',
  'home.catalogue.count': '{ready} of {total} tools ready',

  // Tool status
  'status.soon': 'Coming soon',
  'status.ready': 'Ready',

  // Tool categories
  'category.read': 'Read',
  'category.find': 'Find',
  'category.organize': 'Organize',
  'category.combine': 'Combine & split',
  'category.protect': 'Protect',
  'category.forms': 'Forms & layers',
  'category.ocr': 'Scan & OCR',
  'category.everywhere': 'Everywhere',

  // Tools — label + one-line description
  'tool.read-mode.label': 'Read mode',
  'tool.read-mode.desc': 'Hide everything but the pages',
  'tool.comment.label': 'Comment',
  'tool.comment.desc': 'Sticky notes, text boxes and shapes',
  'tool.highlight.label': 'Highlight text',
  'tool.highlight.desc': 'Highlight, underline or strike out text',
  'tool.draw.label': 'Draw',
  'tool.draw.desc': 'Freehand ink on any page',

  'tool.find.label': 'Find text',
  'tool.find.desc': 'Search the whole document',
  'tool.bookmarks.label': 'Bookmarks',
  'tool.bookmarks.desc': 'Browse and jump through the outline',
  'tool.page-thumbnails.label': 'Page thumbnails',
  'tool.page-thumbnails.desc': 'See every page at a glance',

  'tool.organize-pages.label': 'Organize pages',
  'tool.organize-pages.desc': 'Reorder, rotate, delete and duplicate pages',
  'tool.rotate-pages.label': 'Rotate pages',
  'tool.rotate-pages.desc': 'Turn pages 90° left or right',
  'tool.insert-pages.label': 'Insert pages',
  'tool.insert-pages.desc': 'Add blank pages or pages from another PDF',
  'tool.delete-pages.label': 'Delete pages',
  'tool.delete-pages.desc': 'Remove the pages you don’t need',
  'tool.extract-pages.label': 'Extract pages',
  'tool.extract-pages.desc': 'Save selected pages as a new PDF',

  'tool.combine-files.label': 'Combine files',
  'tool.combine-files.desc': 'Merge several PDFs into one',
  'tool.split-document.label': 'Split document',
  'tool.split-document.desc': 'Split by page count, page numbers or bookmarks',

  'tool.redact.label': 'Redact',
  'tool.redact.desc': 'Permanently black out sensitive content',
  'tool.sanitize.label': 'Sanitize document',
  'tool.sanitize.desc': 'Remove metadata, scripts and hidden content',
  'tool.protect-password.label': 'Password protection',
  'tool.protect-password.desc': 'Encrypt with a password and set permissions',

  'tool.fill-form.label': 'Fill form',
  'tool.fill-form.desc': 'Type into fields, tick boxes and choose options',
  'tool.add-signature.label': 'Add signature',
  'tool.add-signature.desc': 'Draw, type or upload a visual signature',
  'tool.prepare-form.label': 'Prepare form',
  'tool.prepare-form.desc': 'Add text fields, checkboxes, dropdowns and signature fields',
  'tool.flatten-form.label': 'Flatten form',
  'tool.flatten-form.desc': 'Turn fields into fixed page content',
  'tool.layers.label': 'Layers',
  'tool.layers.desc': 'Show or hide optional content',

  'tool.ocr.label': 'Recognize text (OCR)',
  'tool.ocr.desc': 'Make scanned pages searchable',

  'tool.print.label': 'Print',
  'tool.print.desc': 'Print all or part of the document',
  'tool.properties.label': 'Document properties',
  'tool.properties.desc': 'Title, author, fonts, security and more',
  'tool.attachments.label': 'Attachments',
  'tool.attachments.desc': 'View, add and remove embedded files',
  'tool.accessibility-check.label': 'Accessibility checker',
  'tool.accessibility-check.desc': 'Find common accessibility problems',
  'tool.undo-history.label': 'Undo history',
  'tool.undo-history.desc': 'Step back to any earlier state',

  // Common
  'common.ok': 'OK',
  'common.cancel': 'Cancel',
  'common.dismiss': 'Dismiss',

  // Commands
  'command.file.open': 'Open…',
  'command.file.close': 'Close document',
  'command.view.zoomIn': 'Zoom in',
  'command.view.zoomOut': 'Zoom out',
  'command.view.actualSize': 'Actual size',
  'command.view.rotateLeft': 'Rotate view left',
  'command.view.rotateRight': 'Rotate view right',
  'command.view.fullscreen': 'Full screen',
  'command.view.readMode': 'Read mode',
  'command.view.toggleTheme': 'Toggle light/dark theme',
  'command.go.firstPage': 'First page',
  'command.go.lastPage': 'Last page',

  // Opening documents
  'open.loading': 'Opening {name}…',
  'open.error.title': 'Can’t open “{name}”',
  'open.error.invalid': 'This file isn’t a PDF, or it’s too damaged to read.',
  'open.error.missing': 'The file could not be found.',
  'open.error.offline': 'PDF Editor couldn’t download its PDF engine. Check your internet connection and try again.',
  'open.error.generic': 'Something went wrong while opening the file: {message}',
  'drop.overlay': 'Drop a PDF to open it',

  // Password
  'password.title': 'Password required',
  'password.message': '“{name}” is protected. Enter its password to open it.',
  'password.label': 'Password',
  'password.incorrect': 'That password is incorrect. Try again.',
  'password.open': 'Open',

  // Viewer
  'viewer.label': 'Document pages',
  'viewer.pageLabel': 'Page {n}',
  'viewer.pageError.title': 'Page {n} couldn’t be displayed',
  'viewer.pageError.detail': 'This part of the file is damaged. The other pages are unaffected.',
  'viewer.link.internal': 'Go to a location in this document',

  // Links
  'link.title': 'Open external link?',
  'link.message': 'This link leads outside the document, to:',
  'link.open': 'Open link',
  'link.unsupported': 'This kind of link can’t be opened: {url}',

  // Status bar
  'status.label': 'Page and zoom controls',
  'status.pageNumber': 'Page number',
  'status.ofPages': 'of {n}',
  'status.prevPage': 'Previous page',
  'status.nextPage': 'Next page',
  'status.zoomLevel': 'Zoom level',
  'status.zoomPresets': 'Zoom presets',
  'status.layout': 'Page layout',
  'status.soonToast': '“{name}” is coming soon.',

  // Zoom
  'zoom.auto': 'Automatic',
  'zoom.fitWidth': 'Fit width',
  'zoom.fitPage': 'Fit page',

  // Layouts
  'layout.continuous': 'Continuous',
  'layout.single': 'Single page',
  'layout.twoUp': 'Two pages',
  'layout.twoUpCover': 'Two pages with cover',

  // Read mode / full screen
  'readMode.hint': 'Read mode — press Esc to exit',
  'readMode.exit': 'Exit Read mode',
  'readMode.needsDocument': 'Open a PDF to use Read mode.',
  'fullscreen.unavailable': 'Full screen isn’t available here.',
};
