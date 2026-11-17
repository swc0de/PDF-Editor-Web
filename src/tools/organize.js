// Organize tools: all open the page organizer grid.
import { implementTool } from './registry.js';

export function registerOrganizeTools() {
  for (const id of ['organize-pages', 'rotate-pages', 'insert-pages', 'delete-pages']) {
    implementTool(id, ({ app }) => app.openOrganizer());
  }
}
