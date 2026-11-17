// Undo history tool: opens the Undo History panel.
import { implementTool } from './registry.js';

export function registerHistoryTool() {
  implementTool('undo-history', ({ app }) => app.showPanel('history'));
}
