// Find tools: Find text, Bookmarks, Page thumbnails.
import { implementTool } from './registry.js';

export function registerNavigationTools() {
  implementTool('find', ({ app }) => app.openFind());
  implementTool('bookmarks', ({ app }) => app.showPanel('bookmarks'));
  implementTool('page-thumbnails', ({ app }) => app.showPanel('pages'));
}
