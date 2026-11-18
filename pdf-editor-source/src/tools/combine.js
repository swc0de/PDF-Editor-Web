// Combine & split tools, and Extract pages (Organize).
import { implementTool } from './registry.js';

export function registerCombineTools() {
  implementTool('combine-files', ({ app }) => app.openCombine());
  implementTool('split-document', ({ app }) => app.openSplit());
  implementTool('extract-pages', ({ app }) => app.openExtract());
}
