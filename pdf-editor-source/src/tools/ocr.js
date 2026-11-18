// Scan & OCR tool.
import { implementTool } from './registry.js';
import { defineCommand } from '../ui/commands.js';

export function registerOcrTool() {
  implementTool('ocr', ({ app }) => app.ocr.start());
}

export function registerOcrCommands(app) {
  defineCommand({ id: 'ocr.start', label: 'command.ocr.start', icon: 'scanText', enabled: () => !!app.activeTab, run: () => app.ocr.start() });
}
