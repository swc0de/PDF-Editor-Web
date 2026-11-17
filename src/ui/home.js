// Home screen shown when no document is open.
import { h } from './dom.js';
import { icon } from './icons.js';
import { t } from '../i18n/index.js';
import { formatShortcut } from './keys.js';
import { getTool, listTools, toolsByCategory, onRegistryChange } from '../tools/registry.js';
import { RECOMMENDED } from '../tools/catalogue.js';

export function createHome(container) {
  const el = h('div.home', { id: 'home' });
  const render = () => el.replaceChildren(...build());
  render();
  onRegistryChange(render);
  container.append(el);
  return el;
}

function build() {
  const all = listTools();
  const ready = all.filter((tool) => tool.status === 'ready').length;

  const drop = h(
    'section.home-drop',
    { 'aria-labelledby': 'home-drop-title' },
    h('div.home-drop-icon', icon('upload', { size: 28 })),
    h('h1.home-drop-title', { id: 'home-drop-title' }, t('home.drop.title')),
    h('p.muted', t('home.drop.hint')),
    h(
      'div.home-drop-actions',
      // Opening files arrives with the viewer (M1). Shown disabled, not faked.
      h('button.btn.primary', { type: 'button', disabled: true, id: 'home-open' },
        icon('folderOpen'), t('home.drop.open')),
      h('span.badge', t('status.soon')),
    ),
    h('p.home-privacy', icon('shield', { size: 14 }), h('span', t('app.privacy'))),
  );

  const recommended = h(
    'section.home-section',
    { 'aria-label': t('home.catalogue') },
    h('div.tool-grid.recommended', RECOMMENDED.map((id) => toolCard(getTool(id), true))),
  );

  const catalogue = h(
    'section.home-section.catalogue',
    { 'aria-labelledby': 'home-catalogue-title' },
    h(
      'div.section-head',
      h('h2', { id: 'home-catalogue-title' }, t('home.catalogue')),
      h('span.muted', t('home.catalogue.count', { ready, total: all.length })),
    ),
    toolsByCategory().map(({ category, tools }) =>
      h(
        'div.category',
        { dataset: { category } },
        h('h3.category-title', t(`category.${category}`)),
        h('div.tool-grid', tools.map((tool) => toolCard(tool, false))),
      ),
    ),
  );

  return [h('div.home-inner', drop, recommended, catalogue)];
}

function toolCard(tool, large) {
  const soon = tool.status !== 'ready';
  const shortcut = formatShortcut(tool.shortcut);
  const title = [t(tool.label), shortcut && `(${shortcut})`, soon && `— ${t('status.soon')}`]
    .filter(Boolean)
    .join(' ');
  return h(
    `button.tool-card${large ? '.large' : ''}`,
    {
      type: 'button',
      title,
      'aria-disabled': soon ? 'true' : null,
      dataset: { tool: tool.id, status: tool.status },
    },
    h('span.tool-icon', icon(tool.icon, { size: large ? 20 : 16 })),
    h(
      'span.tool-text',
      h(
        'span.tool-head',
        h('span.tool-label', t(tool.label)),
        soon ? h('span.badge', t('status.soon')) : null,
      ),
      h('span.tool-desc', t(tool.description)),
    ),
  );
}
