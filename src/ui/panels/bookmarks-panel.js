// Bookmarks panel: the document outline as an ARIA tree with expand/collapse,
// click (or Enter) to jump, and a search that keeps matches' ancestors visible.
import { h } from '../dom.js';
import { icon } from '../icons.js';
import { t } from '../../i18n/index.js';
import { implementPanel } from '../panels.js';

let counter = 0;

function outlineOf(tab) {
  tab.outlinePromise ??= tab.pdf.getOutline().catch(() => null);
  return tab.outlinePromise;
}

export function registerBookmarksPanel() {
  implementPanel('bookmarks', {
    render(container, tab, app) {
      let disposed = false;
      const search = h('input.input.bookmark-search', {
        type: 'search',
        placeholder: t('bookmarks.search'),
        'aria-label': t('bookmarks.search'),
        autocomplete: 'off',
      });
      const tree = h('ul.tree', { role: 'tree', 'aria-label': t('panel.bookmarks.label') });
      const status = h('p.muted.bookmark-status', { role: 'status' });
      container.append(h('div.panel-toolbar', search), h('div.tree-scroller', tree, status));
      status.textContent = t('bookmarks.loading');

      /** @type {{item, li, row, group, parent, level, expanded, children}[]} */
      const nodes = [];

      function build(items, parentNode, level, ul) {
        items.forEach((item, i) => {
          const hasKids = item.items?.length > 0;
          const id = `bm-${++counter}`;
          const titleEl = h('span.tree-title', item.title || t('bookmarks.untitled'));
          const toggle = hasKids
            ? h('span.tree-toggle', { 'aria-hidden': 'true' }, icon('chevronRight', { size: 14 }))
            : h('span.tree-toggle.leaf', { 'aria-hidden': 'true' });
          const row = h('div.tree-row', { style: { paddingLeft: `${4 + (level - 1) * 16}px` } }, toggle, titleEl);
          const li = h('li.tree-item', {
            role: 'treeitem',
            id,
            tabindex: '-1',
            'aria-level': String(level),
            'aria-setsize': String(items.length),
            'aria-posinset': String(i + 1),
            'aria-expanded': hasKids ? 'false' : null,
          }, row);
          const node = { item, li, row, titleEl, toggle, group: null, parent: parentNode, level, expanded: false, children: [] };
          if (item.bold) titleEl.style.fontWeight = '600';
          if (item.italic) titleEl.style.fontStyle = 'italic';
          nodes.push(node);
          parentNode?.children.push(node);
          ul.append(li);
          if (hasKids) {
            node.group = h('ul.tree-group', { role: 'group', hidden: true });
            li.append(node.group);
            build(item.items, node, level + 1, node.group);
            // PDF "open" outline items have a positive count.
            setExpanded(node, (item.count ?? 0) > 0);
          }
        });
      }

      function setExpanded(node, open) {
        if (!node.group) return;
        node.expanded = open;
        node.li.setAttribute('aria-expanded', String(open));
        node.group.hidden = !open;
      }

      const visibleNodes = () => nodes.filter((n) => !n.li.hidden && ancestorsOpen(n));
      const ancestorsOpen = (n) => {
        for (let p = n.parent; p; p = p.parent) if (!p.expanded || p.li.hidden) return false;
        return true;
      };
      let focused = null;
      function focusNode(node) {
        if (!node) return;
        if (focused) focused.li.tabIndex = -1;
        focused = node;
        node.li.tabIndex = 0;
        node.li.focus();
      }

      async function activate(node) {
        const { item } = node;
        if (item.dest) await tab.viewer.goToDest(item.dest);
        else if (item.url) app.openExternalLink(item.url);
      }

      tree.addEventListener('click', (e) => {
        const li = e.target.closest('.tree-item');
        const node = nodes.find((n) => n.li === li);
        if (!node) return;
        e.stopPropagation();
        focusNode(node);
        if (e.target.closest('.tree-toggle') && node.group) setExpanded(node, !node.expanded);
        else activate(node);
      });
      tree.addEventListener('keydown', (e) => {
        const node = nodes.find((n) => n.li === document.activeElement);
        if (!node) return;
        const vis = visibleNodes();
        const i = vis.indexOf(node);
        let handled = true;
        switch (e.key) {
          case 'ArrowDown': focusNode(vis[i + 1]); break;
          case 'ArrowUp': focusNode(vis[i - 1]); break;
          case 'Home': focusNode(vis[0]); break;
          case 'End': focusNode(vis.at(-1)); break;
          case 'ArrowRight':
            if (node.group && !node.expanded) setExpanded(node, true);
            else if (node.group) focusNode(node.children.find((c) => !c.li.hidden));
            break;
          case 'ArrowLeft':
            if (node.group && node.expanded) setExpanded(node, false);
            else focusNode(node.parent);
            break;
          case 'Enter':
          case ' ':
            activate(node);
            break;
          default: handled = false;
        }
        if (handled) e.preventDefault();
      });

      // ---- search: show matches and their ancestors; mark the matched text
      let savedExpansion = null;
      search.addEventListener('input', () => applyFilter());
      function applyFilter() {
        const q = search.value.trim().toLowerCase();
        if (q && !savedExpansion) savedExpansion = new Map(nodes.map((n) => [n, n.expanded]));
        let matches = 0;
        for (const n of nodes) {
          const title = n.item.title || '';
          const idx = q ? title.toLowerCase().indexOf(q) : -1;
          n.match = idx >= 0;
          n.titleEl.replaceChildren(...(idx >= 0
            ? [title.slice(0, idx), h('mark', title.slice(idx, idx + q.length)), title.slice(idx + q.length)]
            : [title || t('bookmarks.untitled')]));
          if (n.match) matches++;
        }
        if (!q) {
          for (const n of nodes) {
            n.li.hidden = false;
            if (savedExpansion) setExpanded(n, savedExpansion.get(n));
          }
          savedExpansion = null;
          status.textContent = '';
          return;
        }
        const keep = new Set();
        for (const n of nodes) {
          if (!n.match) continue;
          for (let p = n; p; p = p.parent) keep.add(p);
        }
        for (const n of nodes) {
          n.li.hidden = !keep.has(n);
          if (n.group) setExpanded(n, [...keep].some((k) => k.parent === n));
        }
        status.textContent = matches ? t('bookmarks.matches', { n: matches }) : t('bookmarks.noMatch');
      }
      search.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          focusNode(visibleNodes()[0]);
        }
      });

      outlineOf(tab).then((outline) => {
        if (disposed) return;
        if (!outline?.length) {
          search.disabled = true;
          status.replaceChildren(h('span.empty-inline', icon('bookmark', { size: 14 }), t('bookmarks.none')));
          return;
        }
        status.textContent = '';
        build(outline, null, 1, tree);
        const first = nodes[0];
        if (first) first.li.tabIndex = 0;
        focused = first;
        if (search.value.trim()) applyFilter(); // typed before the outline loaded
      });

      return () => { disposed = true; };
    },
  });
}
