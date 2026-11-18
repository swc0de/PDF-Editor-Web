// Commenting tools: comment, highlight, draw — plus a palette command for each
// annotation tool and the Esc / Delete shortcuts while annotating.
import { implementTool } from './registry.js';
import { defineCommand } from '../ui/commands.js';
import { TOOLS } from '../ui/annotate/annotator.js';

export function registerAnnotateTools() {
  implementTool('comment', ({ app }) => {
    app.annotator.activate('select');
    app.showPanel('comments');
  });
  implementTool('highlight', ({ app }) => app.annotator.activate('highlight'));
  implementTool('draw', ({ app }) => app.annotator.activate('ink'));
  implementTool('add-text', ({ app }) => app.annotator.activate('freetext'));
}

export function registerAnnotateCommands(app) {
  const a = () => app.annotator;
  const hasDoc = () => !!app.activeTab && !app.organizerOpen;
  for (const tool of TOOLS) {
    defineCommand({ id: `annotate.${tool}`, label: `command.annot.${tool}`, enabled: hasDoc, checked: () => a().tool === tool, run: () => a().activate(tool) });
  }
  defineCommand({ id: 'annotate.done', label: 'command.annot.done', enabled: () => !!a().tool, run: () => a().deactivate() });
  defineCommand({ id: 'annotate.delete', label: 'annot.delete', shortcut: ['Delete', 'Backspace'], hidden: true, enabled: () => !!a().selected() && !app.organizerOpen, run: () => a().deleteSelected() });
  defineCommand({
    id: 'annotate.editText', label: 'step.editTextBox', shortcut: 'Enter', hidden: true,
    enabled: () => a().selected()?.data.subtype === 'FreeText' && !a().editing && !document.activeElement?.closest?.('.side-panel, .annot-toolbar, .tools-panel, dialog, .menubar'),
    run: () => a().editTextBox(a().selection.page, a().selection.id),
  });
  defineCommand({ id: 'annotate.escape', label: 'annot.done', shortcut: 'Escape', hidden: true, enabled: () => a().canEscape && !app.organizerOpen && !app.findBar.isOpen, run: () => a().escape() });
}
