// Status bar: page navigation, zoom controls and the layout picker.
import { h } from './dom.js';
import { icon } from './icons.js';
import { t } from '../i18n/index.js';
import { openMenu } from './menu.js';
import { formatShortcut } from './keys.js';
import { primaryShortcut, runCommand, getCommand } from './commands.js';

const ZOOM_PRESETS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];

const LAYOUTS = [
  { id: 'continuous', mode: 'continuous', cover: false, icon: 'pageContinuous', label: 'layout.continuous' },
  { id: 'single', mode: 'single', cover: false, icon: 'pageSingle', label: 'layout.single' },
  { id: 'two-up', mode: 'two-up', cover: false, icon: 'pageTwoUp', label: 'layout.twoUp' },
  { id: 'two-up-cover', mode: 'two-up', cover: true, icon: 'pageCover', label: 'layout.twoUpCover' },
];

function layoutOf(viewer) {
  return LAYOUTS.find((l) => l.mode === viewer.mode && (l.mode !== 'two-up' || l.cover === viewer.cover));
}

function iconButton(name, labelKey, commandId, onclick) {
  const shortcut = commandId ? primaryShortcut(commandId) : null;
  const label = t(labelKey);
  return h('button.btn.icon-btn', {
    type: 'button',
    'aria-label': label,
    title: shortcut ? `${label} (${formatShortcut(shortcut)})` : label,
    onclick,
  }, icon(name));
}

export function zoomLabel(zoom) {
  return `${Math.round(zoom * 100)}%`;
}

/** Parse "125", "125%" or "1.25x" into a zoom factor, or null. */
export function parseZoom(text) {
  const m = String(text).trim().match(/^(\d+(?:\.\d+)?)\s*(%|x)?$/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  return m[2]?.toLowerCase() === 'x' ? n : n / 100;
}

export function createStatusBar(viewer) {
  // ---- page navigation
  const pageInput = h('input.input.page-input', {
    type: 'text',
    inputmode: 'numeric',
    'aria-label': t('status.pageNumber'),
    autocomplete: 'off',
  });
  const pageTotal = h('span.page-total', { id: 'page-total' });
  const prevBtn = iconButton('chevronLeft', 'status.prevPage', null, () => viewer.prev());
  const nextBtn = iconButton('chevronRight', 'status.nextPage', null, () => viewer.next());
  pageInput.setAttribute('aria-describedby', 'page-total');

  const commitPage = () => {
    const n = parseInt(pageInput.value, 10);
    if (Number.isFinite(n) && n >= 1 && n <= viewer.numPages) {
      viewer.goToPage(n);
      viewer.focus();
    }
    sync({ force: true });
  };
  pageInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') commitPage();
    if (e.key === 'Escape') {
      sync();
      viewer.focus();
    }
  });
  pageInput.addEventListener('blur', () => sync());
  pageInput.addEventListener('focus', () => pageInput.select());

  // ---- zoom
  const zoomInput = h('input.input.zoom-input', {
    type: 'text',
    'aria-label': t('status.zoomLevel'),
    autocomplete: 'off',
  });
  const zoomMenuBtn = h('button.btn.icon-btn.zoom-menu-btn', {
    type: 'button',
    'aria-label': t('status.zoomPresets'),
    title: t('status.zoomPresets'),
    'aria-haspopup': 'menu',
    'aria-expanded': 'false',
  }, icon('chevronDown', { size: 14 }));
  zoomInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const z = parseZoom(zoomInput.value);
      if (z) viewer.setZoom(z);
      sync({ force: true });
      viewer.focus();
    }
    if (e.key === 'Escape') {
      sync();
      viewer.focus();
    }
  });
  zoomInput.addEventListener('blur', () => sync());
  zoomInput.addEventListener('focus', () => zoomInput.select());
  zoomMenuBtn.addEventListener('click', () => {
    openMenu(zoomMenuBtn, [
      { label: t('zoom.auto'), role: 'menuitemradio', checked: viewer.zoomMode === 'auto', run: () => viewer.setZoom('auto') },
      { label: t('zoom.fitWidth'), role: 'menuitemradio', checked: viewer.zoomMode === 'fit-width', run: () => viewer.setZoom('fit-width') },
      { label: t('zoom.fitPage'), role: 'menuitemradio', checked: viewer.zoomMode === 'fit-page', run: () => viewer.setZoom('fit-page') },
      'separator',
      ...ZOOM_PRESETS.map((z) => ({
        label: zoomLabel(z),
        role: 'menuitemradio',
        checked: viewer.zoomMode === z,
        shortcut: z === 1 ? primaryShortcut('view.actualSize') : undefined,
        run: () => viewer.setZoom(z),
      })),
    ], { placement: 'above', label: t('status.zoomPresets') });
  });

  const zoomOutBtn = iconButton('minus', 'command.view.zoomOut', 'view.zoomOut', () => runCommand('view.zoomOut'));
  const zoomInBtn = iconButton('plus', 'command.view.zoomIn', 'view.zoomIn', () => runCommand('view.zoomIn'));
  const fitWidthBtn = iconButton('fitWidth', 'zoom.fitWidth', null, () => viewer.setZoom('fit-width'));
  const fitPageBtn = iconButton('fitPage', 'zoom.fitPage', null, () => viewer.setZoom('fit-page'));

  // ---- layout picker
  const layoutBtn = h('button.btn.ghost.layout-btn', {
    type: 'button',
    'aria-haspopup': 'menu',
    'aria-expanded': 'false',
    title: t('status.layout'),
  });
  layoutBtn.addEventListener('click', () => {
    const current = layoutOf(viewer);
    const cmd = (id) => ({ shortcut: getCommand(id)?.shortcut ? primaryShortcut(id) : undefined, run: () => runCommand(id) });
    openMenu(layoutBtn, [
      ...LAYOUTS.map((l) => ({
        id: `layout-${l.id}`,
        label: t(l.label),
        icon: l.icon,
        role: 'menuitemradio',
        checked: l === current,
        run: () => viewer.setMode(l.mode, { cover: l.cover }),
      })),
      'separator',
      { id: 'rotate-left', label: t('command.view.rotateLeft'), icon: 'rotateCcw', ...cmd('view.rotateLeft') },
      { id: 'rotate-right', label: t('command.view.rotateRight'), icon: 'rotateCw', ...cmd('view.rotateRight') },
      'separator',
      { id: 'fullscreen', label: t('command.view.fullscreen'), icon: 'maximize', ...cmd('view.fullscreen') },
      { id: 'read-mode', label: t('command.view.readMode'), icon: 'bookOpen', ...cmd('view.readMode') },
    ], { placement: 'above', label: t('status.layout') });
  });

  const bar = h('footer.statusbar', { role: 'toolbar', 'aria-label': t('status.label') },
    h('div.status-group', prevBtn, pageInput, pageTotal, nextBtn),
    h('div.status-spacer'),
    h('div.status-group',
      zoomOutBtn,
      h('div.zoom-combo', zoomInput, zoomMenuBtn),
      zoomInBtn,
      h('span.status-sep', { 'aria-hidden': 'true' }),
      fitWidthBtn,
      fitPageBtn,
      h('span.status-sep', { 'aria-hidden': 'true' }),
      layoutBtn,
    ),
  );

  function sync({ force = false } = {}) {
    const s = viewer.state;
    if (force || document.activeElement !== pageInput) pageInput.value = String(s.page);
    pageInput.style.width = `${Math.max(2, String(s.numPages).length) + 2}ch`;
    pageTotal.textContent = t('status.ofPages', { n: s.numPages });
    prevBtn.disabled = s.page <= 1;
    nextBtn.disabled = s.page >= s.numPages;
    if (force || document.activeElement !== zoomInput) zoomInput.value = zoomLabel(s.zoom);
    fitWidthBtn.setAttribute('aria-pressed', String(s.zoomMode === 'fit-width'));
    fitPageBtn.setAttribute('aria-pressed', String(s.zoomMode === 'fit-page'));
    const l = layoutOf(viewer);
    layoutBtn.replaceChildren(icon(l.icon), h('span.layout-label', t(l.label)), icon('chevronDown', { size: 14 }));
    layoutBtn.setAttribute('aria-label', `${t('status.layout')}: ${t(l.label)}`);
    bar.dataset.page = String(s.page);
    bar.dataset.zoom = String(s.zoom);
  }

  for (const type of ['pagechange', 'zoomchange', 'layoutchange']) viewer.addEventListener(type, () => sync());
  sync();
  return { el: bar, sync, pageInput, zoomInput };
}
