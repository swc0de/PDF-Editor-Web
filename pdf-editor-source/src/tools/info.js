// Document information tools: properties, attachments, layers.
import { implementTool } from './registry.js';
import { openAccessibilityCheck } from '../ui/a11y-check.js';

export function registerInfoTools() {
  implementTool('properties', ({ app }) => app.showPanel('properties'));
  implementTool('attachments', ({ app }) => app.showPanel('attachments'));
  implementTool('layers', ({ app }) => app.showPanel('layers'));
  implementTool('accessibility-check', ({ app }) => openAccessibilityCheck(app));
}
