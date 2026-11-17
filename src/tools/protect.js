// Protect and Everywhere tools: redact, sanitize, password protection, print.
import { implementTool } from './registry.js';
import { defineCommand } from '../ui/commands.js';
import { openSanitize } from '../ui/protect/sanitize-dialog.js';
import { openPasswordDialog } from '../ui/protect/password-dialog.js';

export function registerProtectTools() {
  implementTool('redact', ({ app }) => app.redactor.activate('area'));
  implementTool('sanitize', ({ app }) => openSanitize(app));
  implementTool('protect-password', ({ app }) => openPasswordDialog(app));
  implementTool('print', ({ app }) => app.printer.open());
}

export function registerProtectCommands(app) {
  const hasDoc = () => !!app.activeTab;
  defineCommand({ id: 'file.print', label: 'command.file.print', icon: 'printer', shortcut: 'Mod+P', enabled: hasDoc, run: () => app.printer.open() });
  defineCommand({ id: 'protect.redact', label: 'command.protect.redact', icon: 'redact', enabled: hasDoc, checked: () => app.redactor.active, run: () => app.redactor.activate('area') });
  defineCommand({ id: 'protect.applyRedactions', label: 'command.protect.applyRedactions', enabled: hasDoc, run: () => app.redactor.apply() });
  defineCommand({ id: 'protect.sanitize', label: 'command.protect.sanitize', icon: 'shieldCheck', enabled: hasDoc, run: () => openSanitize(app) });
  defineCommand({ id: 'protect.password', label: 'command.protect.password', icon: 'lock', enabled: hasDoc, run: () => openPasswordDialog(app) });
  defineCommand({ id: 'redact.escape', label: 'annot.done', shortcut: 'Escape', hidden: true, enabled: () => app.redactor.active && !app.findBar.isOpen, run: () => app.redactor.deactivate() });
}
