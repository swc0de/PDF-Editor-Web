// Menu bar contents, built from commands each time a menu opens.
import { t } from '../i18n/index.js';
import { getCommand, primaryShortcut, commandLabel } from './commands.js';
import { listTools } from '../tools/registry.js';

function item(id, { role = 'menuitem', icon: withIcon = true } = {}) {
  const c = getCommand(id);
  return {
    id,
    label: commandLabel(c, t),
    icon: withIcon ? c.icon : undefined,
    shortcut: primaryShortcut(id),
    role,
    checked: c.checked ? c.checked() : undefined,
    disabled: !c.enabled(),
    run: () => c.run(),
  };
}

export function buildMenus(app) {
  return [
    {
      id: 'file',
      label: t('menu.file'),
      items: () => [
        item('file.open'),
        'separator',
        item('file.save'),
        item('file.saveAs'),
        'separator',
        item('file.print'),
        'separator',
        item('tab.close'),
        item('tab.closeOthers'),
        item('tab.reopen'),
        'separator',
        item('app.home'),
        item('app.preferences'),
      ],
    },
    {
      id: 'edit',
      label: t('menu.edit'),
      items: () => [
        item('edit.undo'),
        item('edit.redo'),
        'separator',
        item('page.rotateRight'),
        item('page.rotateLeft'),
        'separator',
        item('edit.copy'),
        item('edit.selectPageText'),
        'separator',
        item('find.open'),
        item('find.next'),
        item('find.prev'),
      ],
    },
    {
      id: 'view',
      label: t('menu.view'),
      items: () => [
        item('view.zoomIn'),
        item('view.zoomOut'),
        item('view.actualSize'),
        item('view.fitWidth', { role: 'menuitemradio' }),
        item('view.fitPage', { role: 'menuitemradio' }),
        'separator',
        item('view.layout.continuous', { role: 'menuitemradio' }),
        item('view.layout.single', { role: 'menuitemradio' }),
        item('view.layout.twoUp', { role: 'menuitemradio' }),
        item('view.layout.twoUpCover', { role: 'menuitemradio' }),
        'separator',
        item('view.rotateLeft'),
        item('view.rotateRight'),
        'separator',
        item('go.back'),
        item('go.forward'),
        'separator',
        item('view.toggleToolsPanel', { role: 'menuitemcheckbox', icon: false }),
        item('view.toggleSidePanel', { role: 'menuitemcheckbox', icon: false }),
        item('view.resetArrangement'),
        'separator',
        item('view.toggleTheme'),
        item('view.fullscreen'),
        item('view.readMode'),
      ],
    },
    {
      id: 'tools',
      label: t('menu.tools'),
      items: () => [
        { id: 'app.palette', label: t('command.app.palette'), icon: 'search', shortcut: primaryShortcut('app.palette'), run: () => app.openPalette() },
        'separator',
        ...listTools({ status: 'ready' }).map((tool) => ({
          id: `tool-${tool.id}`,
          label: t(tool.label),
          icon: tool.icon,
          shortcut: tool.shortcut ?? undefined,
          run: () => app.useTool(tool.id),
        })),
        'separator',
        item('app.allTools'),
      ],
    },
    {
      id: 'help',
      label: t('menu.help'),
      items: () => [item('help.shortcuts'), 'separator', item('help.about')],
    },
  ];
}
