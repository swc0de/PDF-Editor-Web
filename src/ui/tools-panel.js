// Left (or right) tools panel, generated from the tool registry.
import { h } from './dom.js';
import { icon } from './icons.js';
import { t } from '../i18n/index.js';
import { formatShortcut } from './keys.js';
import { toolsByCategory, onRegistryChange } from '../tools/registry.js';
import { createSplitter } from './splitter.js';
import { TOOLS_WIDTH } from '../core/settings.js';

export function createToolsPanel({ onTool, getState, setState, side }) {
  const filter = h('input.input.tools-filter', {
    type: 'search',
    placeholder: t('tools.filter'),
    'aria-label': t('tools.filter'),
    autocomplete: 'off',
  });
  const list = h('div.tools-list');
  const panel = h('aside.tools-panel', { id: 'tools-panel', 'aria-label': t('tools.title') },
    h('div.tools-head', h('h2.tools-title', t('tools.title')), filter),
    list,
  );
  const splitter = createSplitter({
    label: t('tools.resize'),
    get: () => panel.getBoundingClientRect().width,
    set: (w) => { panel.style.width = `${w}px`; },
    commit: (w) => setState({ width: w }),
    range: TOOLS_WIDTH,
    direction: () => (side() === 'left' ? 1 : -1),
  });

  list.addEventListener('click', (e) => {
    const row = e.target.closest('.tool-row');
    if (row) onTool(row.dataset.tool);
  });
  filter.addEventListener('input', () => build());
  filter.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && filter.value) {
      e.stopPropagation();
      filter.value = '';
      build();
    }
  });

  function build() {
    const q = filter.value.trim().toLowerCase();
    const groups = toolsByCategory()
      .map(({ category, tools }) => ({
        category,
        tools: tools.filter((tool) => !q || t(tool.label).toLowerCase().includes(q) || tool.id.includes(q)),
      }))
      .filter((g) => g.tools.length);
    list.replaceChildren(
      ...groups.map(({ category, tools }) =>
        h('section.tools-group', { 'aria-labelledby': `tools-cat-${category}` },
          h('h3.tools-group-title', { id: `tools-cat-${category}` }, t(`category.${category}`)),
          h('ul.tools-items', { role: 'list' }, tools.map((tool) => {
            const soon = tool.status !== 'ready';
            const shortcut = formatShortcut(tool.shortcut);
            return h('li', h('button.tool-row', {
              type: 'button',
              dataset: { tool: tool.id, status: tool.status },
              'aria-disabled': soon ? 'true' : null,
              title: [t(tool.description), shortcut && `(${shortcut})`].filter(Boolean).join(' '),
            },
              icon(tool.icon),
              h('span.tool-row-label', t(tool.label)),
              soon ? h('span.badge', t('status.soon')) : null,
            ));
          })),
        ),
      ),
      groups.length ? null : h('p.muted.tools-none', t('tools.noMatch')),
    );
  }

  function render() {
    const s = getState();
    panel.hidden = !s.visible;
    splitter.el.hidden = !s.visible;
    panel.style.width = `${s.width}px`;
    splitter.sync();
  }

  build();
  onRegistryChange(build);
  return { panel, splitter: splitter.el, render };
}
