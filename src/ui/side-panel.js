// The right edge: an always-visible rail of panel buttons plus one side
// panel beside it, resizable by dragging its inner (left) edge.
import { h } from './dom.js';
import { icon } from './icons.js';
import { t } from '../i18n/index.js';
import { formatShortcut } from './keys.js';
import { PANELS, getPanel } from './panels.js';
import { createSplitter } from './splitter.js';
import { SIDE_WIDTH } from '../core/settings.js';

export function createSidePanel({ getTab, getState, setState }) {
  const title = h('h2.side-panel-title', { id: 'side-panel-title' });
  const closeBtn = h('button.btn.icon-btn', {
    type: 'button',
    'aria-label': t('panel.close'),
    title: `${t('panel.close')} (${formatShortcut('F4')})`,
    onclick: () => setState({ visible: false }),
  }, icon('x', { size: 14 }));
  const body = h('div.side-panel-body');
  const panel = h('aside.side-panel', {
    id: 'side-panel',
    role: 'complementary',
    'aria-labelledby': 'side-panel-title',
  }, h('div.side-panel-head', title, closeBtn), body);

  const splitter = createSplitter({
    label: t('panel.resize'),
    get: () => panel.getBoundingClientRect().width,
    set: (w) => { panel.style.width = `${w}px`; },
    commit: (w) => setState({ width: w }),
    range: SIDE_WIDTH,
    direction: () => -1, // dragging left widens it
  });

  const railButtons = PANELS.map((p) =>
    h('button.btn.icon-btn.rail-btn', {
      type: 'button',
      'aria-label': t(p.label),
      title: t(p.label),
      'aria-controls': 'side-panel',
      dataset: { panel: p.id },
      onclick: () => {
        const s = getState();
        setState(s.visible && s.panel === p.id ? { visible: false } : { visible: true, panel: p.id });
      },
    }, icon(p.icon)),
  );
  const rail = h('nav.rail', { role: 'toolbar', 'aria-orientation': 'vertical', 'aria-label': t('panel.rail') }, railButtons);

  let cleanup = null;
  let rendered = null; // { panel, tab }

  function render() {
    const s = getState();
    const tab = getTab();
    panel.hidden = !s.visible;
    splitter.el.hidden = !s.visible;
    panel.style.width = `${s.width}px`;
    splitter.sync();
    for (const btn of railButtons) {
      btn.setAttribute('aria-pressed', String(s.visible && btn.dataset.panel === s.panel));
    }
    const def = getPanel(s.panel) ?? PANELS[0];
    title.textContent = t(def.label);
    panel.dataset.panel = def.id;
    if (!s.visible) return;
    if (rendered && rendered.panel === def.id && rendered.tab === tab) return;
    cleanup?.();
    cleanup = null;
    body.replaceChildren();
    rendered = { panel: def.id, tab };
    if (tab && def.render) {
      cleanup = def.render(body, tab) ?? null;
    } else {
      body.append(emptyState(def, !!tab));
    }
  }

  return { panel, rail, splitter: splitter.el, render, invalidate: () => { rendered = null; render(); } };
}

function emptyState(def, hasDoc) {
  return h('div.empty-state', { dataset: { empty: hasDoc ? 'soon' : 'no-document' } },
    h('div.empty-icon', icon(def.icon, { size: 22 })),
    h('p.empty-title', hasDoc ? t(`panel.${def.id}.soonTitle`) : t('panel.noDocument.title')),
    h('p.empty-text', hasDoc ? t(`panel.${def.id}.soonText`) : t(`panel.${def.id}.noDocument`)),
    hasDoc ? h('span.badge', t('status.soon')) : null,
  );
}
