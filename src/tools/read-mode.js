// Read mode: hide all chrome and show only the pages. Esc exits.
import { implementTool } from './registry.js';

export function registerReadMode() {
  implementTool('read-mode', ({ app }) => app.toggleReadMode());
}
