// The contextual editing toolbar: tools, then style controls for the active
// tool (or the selected annotation), then delete / comments / done. Text boxes
// get Word-style formatting: font, size, bold / italic / underline,
// alignment, text colour, fill and border.
import { h } from '../dom.js';
import { icon } from '../icons.js';
import { t } from '../../i18n/index.js';
import { FONT_CSS } from './annotator.js';

export const SWATCHES = ['#b70228', '#ffd400', '#00803c', '#0050c8', '#7a00a0', '#1e2327'];
const WIDTHS = [1, 2, 3, 5, 8];
const FONT_SIZES = [8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 32, 36, 48, 72];
const FONTS = ['Helvetica', 'Times', 'Courier'];
const FILLS = [null, '#ffffff', '#fff3a3', '#dbe8ff', '#dff5e1', '#eceef0'];
const BORDERS = [null, '#8a9299', '#1e2327', '#b70228', '#0050c8'];
const TOOL_ICONS = {
  select: 'mousePointer',
  highlight: 'highlighter',
  underline: 'underline',
  strikeout: 'strikethrough',
  note: 'stickyNote',
  freetext: 'textBox',
  square: 'square',
  circle: 'circle',
  line: 'line',
  arrow: 'arrowUpRight',
  ink: 'pen',
};
const GROUPS = [['select'], ['highlight', 'underline', 'strikeout'], ['note', 'freetext'], ['square', 'circle', 'line', 'arrow', 'ink']];
const HAS_WIDTH = new Set(['square', 'circle', 'line', 'arrow', 'ink']);

export function createAnnotateToolbar(annotator) {
  const toolButtons = new Map();
  const groups = GROUPS.map((group) => h('div.annot-group', { role: 'group' }, group.map((tool) => {
    const label = t(`annot.tool.${tool}`);
    const btn = h('button.btn.icon-btn.annot-tool', {
      type: 'button',
      'aria-pressed': 'false',
      'aria-label': label,
      title: label,
      dataset: { tool },
      onclick: () => annotator.activate(tool),
    }, icon(TOOL_ICONS[tool]));
    toolButtons.set(tool, btn);
    return btn;
  })));

  const swatches = SWATCHES.map((color) => {
    const b = h('button.annot-swatch', {
      type: 'button',
      'aria-label': t('annot.colorNamed', { color }),
      title: color,
      'aria-pressed': 'false',
      dataset: { color },
      onclick: () => annotator.setStyle({ color }),
    });
    b.style.setProperty('--swatch', color);
    return b;
  });
  const custom = h('input.annot-color', {
    type: 'color',
    'aria-label': t('annot.customColor'),
    title: t('annot.customColor'),
    onchange: () => annotator.setStyle({ color: custom.value }),
  });
  const opacityValue = h('span.annot-opacity-value');
  const opacity = h('input.annot-opacity', {
    type: 'range', min: '10', max: '100', step: '5',
    'aria-label': t('annot.opacity'),
    title: t('annot.opacity'),
    oninput: () => { opacityValue.textContent = `${opacity.value}%`; },
    onchange: () => annotator.setStyle({ opacity: Number(opacity.value) / 100 }),
  });
  const width = h('select.input.annot-width', {
    'aria-label': t('annot.width'),
    title: t('annot.width'),
    onchange: () => annotator.setStyle({ width: Number(width.value) }),
  }, WIDTHS.map((w) => h('option', { value: String(w) }, t('annot.widthValue', { n: w }))));
  const fontSize = h('select.input.annot-font-size', {
    'aria-label': t('annot.fontSize'),
    title: t('annot.fontSize'),
    onchange: () => annotator.setStyle({ fontSize: Number(fontSize.value) }),
  }, FONT_SIZES.map((s) => h('option', { value: String(s) }, t('annot.fontSizeValue', { n: s }))));

  fontSize.classList.add('annot-font-size');

  // ---- Text box formatting (Word-like)
  const keepFocus = (e) => e.preventDefault(); // buttons don't take the caret out of the text box
  const fontFamily = h('select.input.annot-font', {
    'aria-label': t('annot.font'),
    title: t('annot.font'),
    onchange: () => annotator.setStyle({ fontFamily: fontFamily.value }),
  }, FONTS.map((f) => {
    const o = h('option', { value: f }, t(`annot.fontName.${f}`));
    o.style.fontFamily = FONT_CSS[f];
    return o;
  }));
  const toggle = (key, iconName, shortcut) => h('button.btn.icon-btn.annot-fmt', {
    type: 'button',
    'aria-pressed': 'false',
    'aria-label': t(`annot.${key}`),
    title: `${t(`annot.${key}`)} (${shortcut})`,
    dataset: { fmt: key },
    onmousedown: keepFocus,
    onclick: () => annotator.setStyle({ [key]: !annotator.currentStyle()?.[key] }),
  }, icon(iconName));
  const bold = toggle('bold', 'bold', 'Ctrl+B');
  const italic = toggle('italic', 'italic', 'Ctrl+I');
  const underline = toggle('underlineText', 'underline', 'Ctrl+U');
  underline.onclick = () => annotator.setStyle({ underline: !annotator.currentStyle()?.underline });
  const aligns = ['left', 'center', 'right'].map((a) => h('button.btn.icon-btn.annot-fmt', {
    type: 'button',
    'aria-pressed': 'false',
    'aria-label': t(`annot.align.${a}`),
    title: t(`annot.align.${a}`),
    dataset: { align: a },
    onmousedown: keepFocus,
    onclick: () => annotator.setStyle({ align: a }),
  }, icon(`align${a[0].toUpperCase()}${a.slice(1)}`)));
  const colorSelect = (key, list, labelKey) => {
    const sel = h('select.input.annot-boxcolor', {
      'aria-label': t(labelKey),
      title: t(labelKey),
      dataset: { key },
      onchange: () => annotator.setStyle({ [key]: sel.value || null }),
    }, list.map((c) => h('option', { value: c ?? '' }, t(`annot.${key}Color.${c ? c.slice(1) : 'none'}`))));
    return sel;
  };
  const fill = colorSelect('fill', FILLS, 'annot.fill');
  const border = colorSelect('border', BORDERS, 'annot.border');
  const textGroup = h('div.annot-group.annot-text-format', { role: 'group', 'aria-label': t('annot.textFormat') },
    fontFamily, fontSize, h('span.annot-sep.annot-sep-sm', { 'aria-hidden': 'true' }), bold, italic, underline,
    h('span.annot-sep.annot-sep-sm', { 'aria-hidden': 'true' }), aligns);
  const boxGroup = h('div.annot-group.annot-box-format', { role: 'group', 'aria-label': t('annot.boxFormat') },
    h('label.annot-mini-label', t('annot.fillShort'), fill), h('label.annot-mini-label', t('annot.borderShort'), border));

  const colorGroup = h('div.annot-group.annot-colors', { role: 'group', 'aria-label': t('annot.color') }, swatches, custom);
  const opacityGroup = h('label.annot-group.annot-opacity-group', opacity, opacityValue);
  const widthGroup = h('div.annot-group', width);
  const styleBox = h('div.annot-style', textGroup, colorGroup, opacityGroup, widthGroup, boxGroup);
  for (const b of [...swatches]) b.addEventListener('mousedown', keepFocus);

  const deleteBtn = h('button.btn.icon-btn.annot-delete', {
    type: 'button',
    'aria-label': t('annot.delete'),
    title: `${t('annot.delete')} (Del)`,
    onclick: () => annotator.deleteSelected(),
  }, icon('trash'));
  const commentsBtn = h('button.btn.icon-btn', {
    type: 'button',
    'aria-label': t('annot.openComments'),
    title: t('annot.openComments'),
    onclick: () => annotator.app.showPanel('comments'),
  }, icon('messageSquare'));
  const doneBtn = h('button.btn.annot-done', {
    type: 'button',
    title: `${t('annot.done')} (Esc)`,
    onclick: () => annotator.deactivate(),
  }, t('annot.done'));

  const hint = h('span.annot-hint', { role: 'status', 'aria-live': 'polite' });
  const el = h('div.annot-toolbar', { role: 'toolbar', 'aria-label': t('annot.toolbar'), hidden: true },
    groups, h('span.annot-sep', { 'aria-hidden': 'true' }), styleBox, hint,
    h('div.annot-actions', deleteBtn, commentsBtn, doneBtn));

  // Arrow keys move between the tool buttons (roving focus inside the toolbar).
  el.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    if (e.target.matches('input, select')) return;
    const items = [...el.querySelectorAll('button:not([disabled]):not([hidden])')].filter((b) => b.offsetParent);
    const i = items.indexOf(document.activeElement);
    if (i < 0) return;
    e.preventDefault();
    items[(i + (e.key === 'ArrowRight' ? 1 : -1) + items.length) % items.length].focus();
  });

  function sync() {
    const tool = annotator.tool;
    for (const [id, btn] of toolButtons) {
      btn.setAttribute('aria-pressed', String(id === tool));
      btn.disabled = id !== 'select' && !!annotator.tab?.model.readOnly;
    }
    const styleTool = annotator.editing ? 'freetext' : annotator.styleTool();
    const style = annotator.currentStyle();
    styleBox.hidden = !style;
    if (style) {
      const color = (style.color || '#000000').toLowerCase();
      for (const s of swatches) s.setAttribute('aria-pressed', String(s.dataset.color === color));
      custom.value = color;
      const pct = Math.round((style.opacity ?? 1) * 100);
      opacity.value = String(pct);
      opacityValue.textContent = `${pct}%`;
      widthGroup.hidden = !HAS_WIDTH.has(styleTool);
      if (!widthGroup.hidden) width.value = String(WIDTHS.reduce((a, b) => (Math.abs(b - style.width) < Math.abs(a - style.width) ? b : a)));
      const text = styleTool === 'freetext';
      textGroup.hidden = !text;
      boxGroup.hidden = !text;
      opacityGroup.hidden = text;
      if (text) {
        fontSize.value = String(FONT_SIZES.reduce((a, b) => (Math.abs(b - style.fontSize) < Math.abs(a - style.fontSize) ? b : a)));
        fontFamily.value = FONTS.includes(style.fontFamily) ? style.fontFamily : 'Helvetica';
        bold.setAttribute('aria-pressed', String(!!style.bold));
        italic.setAttribute('aria-pressed', String(!!style.italic));
        underline.setAttribute('aria-pressed', String(!!style.underline));
        for (const b of aligns) b.setAttribute('aria-pressed', String((style.align || 'left') === b.dataset.align));
        fill.value = FILLS.includes(style.fill) ? style.fill ?? '' : '';
        border.value = BORDERS.includes(style.border) ? style.border ?? '' : '';
      }
    }
    const sel = annotator.selected();
    deleteBtn.hidden = !sel;
    deleteBtn.disabled = !!annotator.tab?.model.readOnly;
    hint.textContent = sel ? '' : t(`annot.hint.${tool || 'select'}`);
  }

  const main = annotator.app.shell.main;
  new ResizeObserver(() => {
    if (!el.hidden) main.style.setProperty('--annot-bar-h', `${el.offsetHeight}px`);
  }).observe(el);

  return {
    el,
    sync,
    show() {
      el.hidden = false;
      annotator.app.shell.main.classList.add('annot-on');
    },
    hide() {
      el.hidden = true;
      annotator.app.shell.main.classList.remove('annot-on');
    },
  };
}
