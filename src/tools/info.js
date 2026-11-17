// Document information tools: properties, attachments, layers.
import { implementTool } from './registry.js';

export function registerInfoTools() {
  implementTool('properties', ({ app }) => app.showPanel('properties'));
  implementTool('attachments', ({ app }) => app.showPanel('attachments'));
  implementTool('layers', ({ app }) => app.showPanel('layers'));
}
