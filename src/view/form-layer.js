// HTML form controls over a page's widget annotations (pdf.js renders pages
// in ENABLE_FORMS mode: text/choice widgets draw only their box, and
// checkbox/radio/push-button appearances come back as separate canvases).
//
// The layer is kept across document reloads: when the same widgets come back
// (after a fill, or undo), values are updated in place so focus and the
// caret survive. Commits are reported through `onCommit({ name, value })`.
import { h } from '../ui/dom.js';
import { t } from '../i18n/index.js';

const FLAG_PASSWORD = 1 << 13;
const FLAG_EDIT = 1 << 18;
const sameValue = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const rgb = (c) => (c && c.length >= 3 ? `rgb(${c[0]}, ${c[1]}, ${c[2]})` : null);

/** The value a widget's data represents, in the shape onCommit uses. */
export function widgetValue(data) {
  if (data.fieldType === 'Btn') {
    if (data.checkBox) return !!data.fieldValue && data.fieldValue !== 'Off' && data.fieldValue === data.exportValue;
    if (data.radioButton) return data.fieldValue && data.fieldValue !== 'Off' ? data.fieldValue : null;
    return null;
  }
  if (data.fieldType === 'Ch') {
    const v = Array.isArray(data.fieldValue) ? data.fieldValue : data.fieldValue ? [data.fieldValue] : [];
    return data.combo ? v[0] ?? '' : v;
  }
  return data.fieldValue ?? '';
}

export class FormLayer {
  /**
   * @param {object} o
   * @param {string} o.scope       unique per tab (radio group names)
   * @param {(c:{name,value,id}) => void} o.onCommit
   * @param {(c:{name,id,rect}) => void} o.onSign
   * @param {(dir:1|-1) => boolean} o.onTabOut   return true if handled
   * @param {() => boolean} o.isReadOnly
   */
  constructor({ scope, onCommit, onSign, onTabOut, isReadOnly }) {
    this.scope = scope;
    this.onCommit = onCommit;
    this.onSign = onSign;
    this.onTabOut = onTabOut;
    this.isReadOnly = isReadOnly ?? (() => false);
    this.el = h('div.formLayer');
    this.items = new Map(); // widget id → { data, el, control, canvases }
    this.key = null;
    this.pending = new Map(); // field name → value committed but not yet back from the document
    this.el.addEventListener('keydown', (e) => this.onKey(e));
  }

  /** Render (or update in place) for the page's widgets. */
  render(widgets, view, pdfjs, viewport) {
    pdfjs.setLayerDimensions(this.el, viewport);
    const list = widgets.filter((w) => !w.hidden);
    const key = list.map((w) => `${w.id}:${w.fieldName}:${w.fieldType}`).join('|');
    if (key === this.key) {
      for (const w of list) this.update(w, view);
      return;
    }
    const focusedId = this.el.contains(document.activeElement) ? document.activeElement.closest('[data-widget-id]')?.dataset.widgetId : null;
    this.key = key;
    this.items.clear();
    this.el.replaceChildren(...list.map((w) => this.build(w, view)).filter(Boolean));
    if (focusedId) this.items.get(focusedId)?.control?.focus({ preventScroll: true });
  }

  position(el, data, view) {
    const [vx0, vy0, vx1, vy1] = view;
    const W = vx1 - vx0;
    const H = vy1 - vy0;
    const [x0, y0, x1, y1] = [Math.min(data.rect[0], data.rect[2]), Math.min(data.rect[1], data.rect[3]), Math.max(data.rect[0], data.rect[2]), Math.max(data.rect[1], data.rect[3])];
    Object.assign(el.style, {
      left: `${((x0 - vx0) / W) * 100}%`,
      top: `${((vy1 - y1) / H) * 100}%`,
      width: `${((x1 - x0) / W) * 100}%`,
      height: `${((y1 - y0) / H) * 100}%`,
    });
    return { w: x1 - x0, h: y1 - y0 };
  }

  build(data, view) {
    const readOnly = data.readOnly || this.isReadOnly();
    const label = data.alternativeText || data.fieldName || '';
    const wrap = h(`div.form-field.ff-${kindOf(data)}`, {
      dataset: { widgetId: data.id, fieldName: data.fieldName ?? '', kind: kindOf(data) },
    });
    const size = this.position(wrap, data, view);
    if (data.required) wrap.classList.add('required');
    if (readOnly) wrap.classList.add('readonly');
    const item = { data, el: wrap, control: null, canvases: null };
    const da = data.defaultAppearanceData ?? {};
    const font = (multi) => {
      let pt = da.fontSize || 0;
      if (multi) pt = pt && pt <= 24 ? pt : 12;
      else pt = Math.min(pt || size.h * 0.65, size.h * 0.8);
      return `calc(var(--total-scale-factor, var(--scale-factor)) * ${Math.max(4, pt).toFixed(2)}px)`;
    };
    const textStyle = (el, multi) => {
      el.style.fontSize = font(multi);
      el.style.color = rgb(da.fontColor) ?? '';
      if (data.textAlignment === 1) el.style.textAlign = 'center';
      if (data.textAlignment === 2) el.style.textAlign = 'right';
    };
    const commit = (value) => {
      if (sameValue(value, item.committed)) return;
      item.committed = value;
      this.pending.set(data.fieldName, value);
      wrap.classList.add('pending');
      this.onCommit({ name: data.fieldName, value, id: data.id });
    };

    switch (kindOf(data)) {
      case 'text': {
        const multi = !!data.multiLine;
        const control = multi
          ? h('textarea.form-control', { 'aria-label': label, readOnly, spellcheck: false })
          : h('input.form-control', { type: data.fieldFlags & FLAG_PASSWORD ? 'password' : 'text', 'aria-label': label, readOnly, spellcheck: false, autocomplete: 'off' });
        if (data.maxLen) control.maxLength = data.maxLen;
        if (data.required) control.setAttribute('aria-required', 'true');
        textStyle(control, multi);
        control.value = widgetValue(data);
        item.committed = control.value;
        control.addEventListener('change', () => commit(control.value));
        if (!multi) control.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') commit(control.value);
        });
        item.control = control;
        wrap.append(control);
        break;
      }
      case 'checkbox':
      case 'radio': {
        const radio = kindOf(data) === 'radio';
        const control = h('input.form-toggle', {
          type: radio ? 'radio' : 'checkbox',
          name: radio ? `${this.scope}:${data.fieldName}` : null,
          value: radio ? data.buttonValue : null,
          'aria-label': radio ? `${label}: ${data.buttonValue}` : label,
          disabled: readOnly,
        });
        control.checked = radio ? widgetValue(data) === data.buttonValue : widgetValue(data);
        item.committed = radio ? widgetValue(data) : control.checked;
        control.addEventListener('change', () => {
          this.syncToggle(item);
          if (radio) {
            if (control.checked) commit(data.buttonValue);
          } else {
            commit(control.checked);
          }
        });
        item.control = control;
        item.box = h('div.form-appearance', { 'aria-hidden': 'true' });
        wrap.append(item.box, control);
        wrap.classList.toggle('checked', control.checked);
        break;
      }
      case 'choice': {
        const opts = data.options ?? [];
        const value = widgetValue(data);
        let control;
        if (data.combo && data.fieldFlags & FLAG_EDIT) {
          const listId = `dl-${this.scope}-${data.id}`;
          control = h('input.form-control', { type: 'text', 'aria-label': label, readOnly, list: listId, autocomplete: 'off' });
          wrap.append(h('datalist', { id: listId }, opts.map((o) => h('option', { value: o.exportValue }, o.displayValue))));
          control.value = value;
          control.addEventListener('change', () => commit(control.value));
        } else {
          control = h('select.form-control', { 'aria-label': label, disabled: readOnly, multiple: !data.combo && data.multiSelect });
          if (!data.combo) control.size = Math.max(2, opts.length);
          if (data.combo && !opts.some((o) => o.exportValue === value)) control.append(h('option', { value: '' }, ''));
          control.append(...opts.map((o) => h('option', { value: o.exportValue }, o.displayValue)));
          setSelect(control, value);
          control.addEventListener('change', () => commit(data.combo ? control.value : [...control.selectedOptions].map((o) => o.value)));
        }
        textStyle(control, !data.combo);
        item.committed = value;
        item.control = control;
        wrap.append(control);
        break;
      }
      case 'signature': {
        const btn = h('button.form-sign', {
          type: 'button',
          'aria-label': t('forms.signField', { name: label }),
          title: t('forms.signFieldHint'),
          disabled: readOnly,
          onclick: () => this.onSign({ name: data.fieldName, id: data.id, rect: [...data.rect] }),
        }, h('span.form-sign-label', t('forms.sign')));
        item.control = btn;
        wrap.append(btn);
        break;
      }
      case 'button': {
        item.box = h('div.form-appearance', { 'aria-hidden': 'true' });
        wrap.title = t('forms.buttonInert');
        wrap.append(item.box);
        break;
      }
      default:
        return null;
    }
    if (item.control && !item.control.id) item.control.dataset.widgetId = data.id;
    this.items.set(data.id, item);
    if (this.canvasMap) this.applyCanvas(item);
    return wrap;
  }

  /** New data for an existing widget: refresh its value unless the user is in it. */
  update(data, view) {
    const item = this.items.get(data.id);
    if (!item) return;
    item.data = data;
    if (view) this.position(item.el, data, view);
    const value = widgetValue(data);
    const pendingValue = this.pending.get(data.fieldName);
    if (this.pending.has(data.fieldName)) {
      if (!sameValue(pendingValue, value)) return;
      this.pending.delete(data.fieldName);
    }
    item.el.classList.remove('pending');
    const c = item.control;
    if (!c || c === document.activeElement) {
      item.committed = value;
      return;
    }
    switch (kindOf(data)) {
      case 'text':
        c.value = value;
        break;
      case 'checkbox':
        c.checked = value;
        this.syncToggle(item);
        break;
      case 'radio':
        c.checked = value === data.buttonValue;
        this.syncToggle(item);
        break;
      case 'choice':
        if (c.tagName === 'SELECT') setSelect(c, value);
        else c.value = value;
        break;
      default:
    }
    item.committed = value;
  }

  /** Forget uncommitted-looking state (a commit failed): show the document's values again. */
  clearPending() {
    this.pending.clear();
    for (const item of this.items.values()) {
      item.el.classList.remove('pending');
      item.control?.blur?.();
      this.update(item.data, null);
    }
  }

  /** Appearance canvases from pdf.js (checkbox/radio: [checked, unchecked]; push button: one). */
  setCanvases(map) {
    this.canvasMap = map;
    for (const item of this.items.values()) this.applyCanvas(item);
  }

  applyCanvas(item) {
    if (!item.box) return;
    const entry = this.canvasMap?.get(item.data.id);
    const list = Array.isArray(entry) ? entry : entry ? [entry] : [];
    item.canvases = list;
    item.box.replaceChildren(...list);
    item.el.classList.toggle('has-appearance', list.length > 0);
    this.syncToggle(item);
  }

  syncToggle(item) {
    const on = !!item.control?.checked;
    item.el.classList.toggle('checked', on);
    for (const c of item.canvases ?? []) {
      const name = c.dataset.canvasName;
      c.hidden = name ? (name === 'checked') !== on : false;
    }
    // Radio siblings in this layer.
    if (item.control?.type === 'radio') {
      for (const other of this.items.values()) {
        if (other !== item && other.control?.type === 'radio' && other.control.name === item.control.name) {
          other.el.classList.toggle('checked', other.control.checked);
          for (const c of other.canvases ?? []) {
            const name = c.dataset.canvasName;
            c.hidden = name ? (name === 'checked') !== other.control.checked : false;
          }
        }
      }
    }
  }

  focusables() {
    return [...this.el.querySelectorAll('input, select, textarea, button')].filter((el) => !el.disabled && el.tabIndex >= 0);
  }

  onKey(e) {
    if (e.key !== 'Tab' || e.defaultPrevented) return;
    const list = this.focusables();
    const i = list.indexOf(e.target);
    if (i < 0) return;
    const last = e.shiftKey ? i === 0 : i === list.length - 1;
    if (last && this.onTabOut?.(e.shiftKey ? -1 : 1)) e.preventDefault();
  }

  focusEdge(dir) {
    const list = this.focusables();
    const el = dir > 0 ? list[0] : list.at(-1);
    el?.focus();
    return !!el;
  }

  focusField(name) {
    const item = [...this.items.values()].find((it) => it.data.fieldName === name && it.control);
    if (!item) return false;
    item.control.focus();
    return true;
  }
}

export function kindOf(data) {
  switch (data.fieldType) {
    case 'Tx': return 'text';
    case 'Ch': return 'choice';
    case 'Sig': return 'signature';
    case 'Btn': return data.checkBox ? 'checkbox' : data.radioButton ? 'radio' : 'button';
    default: return 'unknown';
  }
}

function setSelect(select, value) {
  const values = new Set(Array.isArray(value) ? value : [value]);
  for (const o of select.options) o.selected = values.has(o.value);
}
