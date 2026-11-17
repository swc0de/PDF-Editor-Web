// The complete tool catalogue. Every planned tool is defined here as
// "Coming soon"; each tool's module calls implementTool() when it's built.
import { defineTool } from './registry.js';

const CATALOGUE = [
  // Read
  { id: 'read-mode', category: 'read', icon: 'bookOpen', milestone: 'M1' },
  { id: 'add-text', category: 'read', icon: 'textBox', milestone: 'M8' },
  { id: 'comment', category: 'read', icon: 'messageSquare', milestone: 'M8' },
  { id: 'highlight', category: 'read', icon: 'highlighter', milestone: 'M8' },
  { id: 'draw', category: 'read', icon: 'pen', milestone: 'M8' },

  // Find
  { id: 'find', category: 'find', icon: 'search', shortcut: 'Mod+F', milestone: 'M3' },
  { id: 'bookmarks', category: 'find', icon: 'bookmark', milestone: 'M3' },
  { id: 'page-thumbnails', category: 'find', icon: 'grid', milestone: 'M3' },

  // Organize
  { id: 'organize-pages', category: 'organize', icon: 'layoutPages', milestone: 'M5' },
  { id: 'rotate-pages', category: 'organize', icon: 'rotateCw', milestone: 'M5' },
  { id: 'insert-pages', category: 'organize', icon: 'filePlus', milestone: 'M5' },
  { id: 'delete-pages', category: 'organize', icon: 'trash', milestone: 'M5' },
  { id: 'extract-pages', category: 'organize', icon: 'fileOutput', milestone: 'M6' },

  // Combine & split
  { id: 'combine-files', category: 'combine', icon: 'files', milestone: 'M6' },
  { id: 'split-document', category: 'combine', icon: 'scissors', milestone: 'M6' },

  // Protect
  { id: 'redact', category: 'protect', icon: 'redact', milestone: 'M10' },
  { id: 'sanitize', category: 'protect', icon: 'shieldCheck', milestone: 'M10' },
  { id: 'protect-password', category: 'protect', icon: 'lock', milestone: 'M10' },

  // Forms & layers
  { id: 'fill-form', category: 'forms', icon: 'textInput', milestone: 'M9' },
  { id: 'add-signature', category: 'forms', icon: 'signature', milestone: 'M9' },
  { id: 'prepare-form', category: 'forms', icon: 'squarePlus', milestone: 'M9' },
  { id: 'flatten-form', category: 'forms', icon: 'stamp', milestone: 'M9' },
  { id: 'layers', category: 'forms', icon: 'layers', milestone: 'M7' },

  // Scan & OCR
  { id: 'ocr', category: 'ocr', icon: 'scanText', milestone: 'M11' },

  // Everywhere
  { id: 'print', category: 'everywhere', icon: 'printer', shortcut: 'Mod+P', milestone: 'M10' },
  { id: 'properties', category: 'everywhere', icon: 'info', milestone: 'M7' },
  { id: 'attachments', category: 'everywhere', icon: 'paperclip', milestone: 'M7' },
  { id: 'accessibility-check', category: 'everywhere', icon: 'accessibility', milestone: 'M12' },
  { id: 'undo-history', category: 'everywhere', icon: 'history', milestone: 'M4' },
];

/** Tools featured on the home screen. */
export const RECOMMENDED = [
  'organize-pages',
  'combine-files',
  'comment',
  'fill-form',
  'redact',
  'ocr',
];

export function registerCatalogue() {
  for (const def of CATALOGUE) defineTool(def);
}
