// Home screen: open/drop zone, recent files, recommended tools, catalogue.
import { h } from './dom.js';
import { icon } from './icons.js';
import { t } from '../i18n/index.js';
import { formatShortcut } from './keys.js';
import { formatBytes, formatRelativeTime } from './format.js';
import { getTool, listTools, toolsByCategory, onRegistryChange } from '../tools/registry.js';
import { RECOMMENDED } from '../tools/catalogue.js';
import { listRecents, onRecentsChange } from '../core/recents.js';

/**
 * @param {HTMLElement} container
 * @param {object} actions  onOpen, onTool(id), onOpenRecent(rec), onRemoveRecent(rec), onClearRecents()
 */
export function createHome(container, actions) {
  const el = h('div.home', { id: 'home' });
  const recentsSlot = h('section.home-section.recents', { 'aria-labelledby': 'home-recents-title' });
  const toolsSlot = h('div.home-tools');
  let thumbUrls = [];

  el.addEventListener('click', (e) => {
    const card = e.target.closest('.tool-card');
    if (card) actions.onTool(card.dataset.tool);
  });

  const drop = h('section.home-drop', { 'aria-labelledby': 'home-drop-title' },
    h('div.home-drop-icon', icon('upload', { size: 28 })),
    h('h1.home-drop-title', { id: 'home-drop-title' }, t('home.drop.title')),
    h('p.muted', t('home.drop.hint')),
    h('div.home-drop-actions',
      h('button.btn.primary', { type: 'button', id: 'home-open', onclick: actions.onOpen },
        icon('folderOpen'), t('home.drop.open')),
      h('span.muted.home-shortcut', formatShortcut('Mod+O')),
    ),
    h('p.home-privacy', icon('shield', { size: 14 }), h('span', t('app.privacy'))),
  );

  el.append(h('div.home-inner', drop, recentsSlot, toolsSlot));
  container.append(el);

  async function renderRecents() {
    const recents = await listRecents();
    thumbUrls.forEach((u) => URL.revokeObjectURL(u));
    thumbUrls = [];
    const head = h('div.section-head',
      h('h2', { id: 'home-recents-title' }, t('home.recents')),
      recents.length ? h('button.btn.ghost.btn-sm', { type: 'button', onclick: actions.onClearRecents }, t('home.recents.clear')) : null,
    );
    if (!recents.length) {
      recentsSlot.replaceChildren(head, h('p.muted.recents-empty', t('home.recents.empty')));
      return;
    }
    const cards = recents.map((rec) => {
      let thumb;
      if (rec.thumbnail) {
        const url = URL.createObjectURL(rec.thumbnail);
        thumbUrls.push(url);
        thumb = h('img.recent-thumb', { src: url, alt: '' });
      } else {
        thumb = h('div.recent-thumb.placeholder', icon('file', { size: 24 }));
      }
      const meta = [
        rec.pageCount ? t('home.recents.pages', { n: rec.pageCount }) : null,
        formatBytes(rec.size),
      ].filter(Boolean).join(' · ');
      return h('li.recent', { dataset: { recentId: rec.id } },
        h('button.recent-open', {
          type: 'button',
          title: rec.stored ? t('home.recents.open', { name: rec.name }) : t('home.recents.notStored'),
          onclick: () => actions.onOpenRecent(rec),
        },
          thumb,
          h('span.recent-name', rec.name),
          h('span.recent-meta', meta),
          h('span.recent-time', formatRelativeTime(rec.lastOpened)),
        ),
        h('button.btn.icon-btn.recent-remove', {
          type: 'button',
          'aria-label': t('home.recents.remove', { name: rec.name }),
          title: t('home.recents.removeShort'),
          onclick: () => actions.onRemoveRecent(rec),
        }, icon('x', { size: 14 })),
      );
    });
    recentsSlot.replaceChildren(head,
      h('ul.recent-grid', { role: 'list' }, cards),
      h('p.muted.recents-note', icon('shield', { size: 12 }), t('home.recents.note')));
  }

  function renderTools() {
    const all = listTools();
    const ready = all.filter((tool) => tool.status === 'ready').length;
    toolsSlot.replaceChildren(
      h('section.home-section', { 'aria-labelledby': 'home-recommended-title' },
        h('div.section-head', h('h2', { id: 'home-recommended-title' }, t('home.recommended'))),
        h('div.tool-grid.recommended', RECOMMENDED.map((id) => toolCard(getTool(id), true)))),
      h('section.home-section.catalogue', { 'aria-labelledby': 'home-catalogue-title' },
        h('div.section-head',
          h('h2', { id: 'home-catalogue-title' }, t('home.catalogue')),
          h('span.muted', t('home.catalogue.count', { ready, total: all.length }))),
        toolsByCategory().map(({ category, tools }) =>
          h('div.category', { dataset: { category } },
            h('h3.category-title', t(`category.${category}`)),
            h('div.tool-grid', tools.map((tool) => toolCard(tool, false)))))),
    );
  }

  renderRecents();
  renderTools();
  onRecentsChange(renderRecents);
  onRegistryChange(renderTools);
  return el;
}

function toolCard(tool, large) {
  const soon = tool.status !== 'ready';
  const shortcut = formatShortcut(tool.shortcut);
  const title = [t(tool.label), shortcut && `(${shortcut})`, soon && `— ${t('status.soon')}`].filter(Boolean).join(' ');
  return h(`button.tool-card${large ? '.large' : ''}`, {
    type: 'button',
    title,
    'aria-disabled': soon ? 'true' : null,
    dataset: { tool: tool.id, status: tool.status },
  },
    h('span.tool-icon', icon(tool.icon, { size: large ? 20 : 16 })),
    h('span.tool-text',
      h('span.tool-head', h('span.tool-label', t(tool.label)), soon ? h('span.badge', t('status.soon')) : null),
      h('span.tool-desc', t(tool.description))),
  );
}
