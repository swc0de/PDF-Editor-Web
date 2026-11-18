// The document tab strip (role="tablist").
import { h } from './dom.js';
import { icon } from './icons.js';
import { t } from '../i18n/index.js';
import { formatShortcut } from './keys.js';

/**
 * @param {object} o
 * @param {(id:string|null) => void} o.onActivate   null = Home
 * @param {(id:string) => void} o.onClose
 * @param {(id:string, point:{x:number,y:number}, anchor:HTMLElement) => void} o.onContextMenu
 * @param {() => void} o.onOpen
 */
export function createTabStrip({ onActivate, onClose, onContextMenu, onOpen }) {
  const homeBtn = h('button.btn.icon-btn.home-btn', {
    type: 'button',
    'aria-label': t('tabs.home'),
    title: t('tabs.home'),
    onclick: () => onActivate(null),
  }, icon('home'));
  const list = h('div.tab-list', { role: 'tablist', 'aria-label': t('tabs.label') });
  const scroller = h('div.tab-scroller', list);
  const openBtn = h('button.btn.icon-btn.tab-open', {
    type: 'button',
    id: 'topbar-open',
    'aria-label': t('command.file.open'),
    title: `${t('command.file.open')} (${formatShortcut('Mod+O')})`,
    onclick: onOpen,
  }, icon('plus'));
  const el = h('div.tabstrip', homeBtn, scroller, openBtn);

  // Vertical wheel scrolls the strip horizontally.
  scroller.addEventListener('wheel', (e) => {
    if (Math.abs(e.deltaY) > Math.abs(e.deltaX) && scroller.scrollWidth > scroller.clientWidth) {
      e.preventDefault();
      scroller.scrollLeft += e.deltaY;
    }
  }, { passive: false });

  list.addEventListener('keydown', (e) => {
    const tabs = [...list.querySelectorAll('[role="tab"]')];
    const i = tabs.indexOf(document.activeElement);
    if (i < 0) return;
    let next = null;
    if (e.key === 'ArrowRight') next = tabs[(i + 1) % tabs.length];
    else if (e.key === 'ArrowLeft') next = tabs[(i - 1 + tabs.length) % tabs.length];
    else if (e.key === 'Home') next = tabs[0];
    else if (e.key === 'End') next = tabs.at(-1);
    else if (e.key === 'Delete') {
      e.preventDefault();
      onClose(tabs[i].dataset.tabId);
      return;
    } else if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
      e.preventDefault();
      const r = tabs[i].getBoundingClientRect();
      onContextMenu(tabs[i].dataset.tabId, { x: r.left, y: r.bottom + 2 }, tabs[i]);
      return;
    }
    if (next) {
      e.preventDefault();
      onActivate(next.dataset.tabId);
      // Activating re-renders the strip; keep keyboard focus on the tab.
      list.querySelector('[role="tab"][aria-selected="true"]')?.focus();
    }
  });

  /** @param {{id:string,name:string,dirty:boolean}[]} tabs */
  function render(tabs, activeId) {
    homeBtn.setAttribute('aria-pressed', String(activeId === null));
    list.replaceChildren(...tabs.map((tab) => {
      const active = tab.id === activeId;
      const tabEl = h('button.tab', {
        type: 'button',
        role: 'tab',
        id: `tab-${tab.id}`,
        'aria-selected': String(active),
        'aria-controls': `tabpanel-${tab.id}`,
        'aria-keyshortcuts': 'Delete',
        tabindex: active || (activeId === null && tab === tabs[0]) ? '0' : '-1',
        title: tab.dirty ? `${tab.name} — ${t('tabs.unsaved')}` : tab.name,
        dataset: { tabId: tab.id },
        onclick: () => onActivate(tab.id),
        onauxclick: (e) => { if (e.button === 1) onClose(tab.id); },
        oncontextmenu: (e) => {
          e.preventDefault();
          onContextMenu(tab.id, { x: e.clientX, y: e.clientY }, tabEl);
        },
      },
        h('span.tab-name', tab.name),
        tab.dirty ? h('span.tab-dirty', { 'aria-label': t('tabs.unsaved'), role: 'img' }) : null,
      );
      // Mouse convenience only: the tab itself closes with Delete or Ctrl/⌘+W
      // (and has a context menu), so the button stays out of the tablist's
      // accessibility tree.
      const close = h('button.tab-close', {
        type: 'button',
        tabindex: '-1',
        'aria-hidden': 'true',
        'aria-label': t('tabs.closeNamed', { name: tab.name }),
        title: `${t('tabs.close')} (${formatShortcut('Mod+W')})`,
        onclick: (e) => {
          e.stopPropagation();
          onClose(tab.id);
        },
      }, icon('x', { size: 12 }));
      return h(`div.tab-item${active ? '.active' : ''}${tab.dirty ? '.dirty' : ''}`, { dataset: { tabId: tab.id } }, tabEl, close);
    }));
    const activeEl = list.querySelector('.tab-item.active');
    activeEl?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  return { el, render, list, homeBtn };
}
