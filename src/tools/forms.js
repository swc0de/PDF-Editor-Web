// Forms and signatures tools: fill, sign, prepare, flatten — plus palette
// commands and the Delete / Escape shortcuts of the form editor.
import { implementTool } from './registry.js';
import { defineCommand } from '../ui/commands.js';
import { FIELD_TOOLS } from '../ui/forms/form-editor.js';

export function registerFormTools() {
  implementTool('fill-form', ({ app }) => app.forms.startFilling());
  implementTool('add-signature', ({ app }) => app.forms.startSigning());
  implementTool('prepare-form', ({ app }) => {
    app.formEditor.activate('select');
    app.showPanel('fields');
  });
  implementTool('flatten-form', ({ app }) => app.forms.flatten());
}

export function registerFormCommands(app) {
  const fe = () => app.formEditor;
  const hasDoc = () => !!app.activeTab && !app.organizerOpen;
  defineCommand({ id: 'view.highlightFields', label: 'command.view.highlightFields', icon: 'textInput', checked: () => app.forms.highlight, run: () => app.forms.setHighlight(!app.forms.highlight) });
  for (const tool of FIELD_TOOLS) {
    defineCommand({ id: `formEdit.${tool}`, label: `command.formEdit.${tool}`, enabled: hasDoc, checked: () => fe().tool === tool, run: () => fe().activate(tool) });
  }
  defineCommand({ id: 'formEdit.done', label: 'command.formEdit.done', enabled: () => !!fe().tool, run: () => fe().deactivate() });
  defineCommand({ id: 'formEdit.delete', label: 'formTool.delete', shortcut: ['Delete', 'Backspace'], hidden: true, enabled: () => !!fe().tool && !!fe().widgetData(), run: () => fe().deleteSelected() });
  defineCommand({ id: 'formEdit.escape', label: 'annot.done', shortcut: 'Escape', hidden: true, enabled: () => fe().canEscape && !app.findBar.isOpen, run: () => fe().escape() });
}
