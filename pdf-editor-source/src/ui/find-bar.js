// The find bar (⌘F): one bar for the app, searching the active tab.
import { h } from './dom.js';
import { icon } from './icons.js';
import { t } from '../i18n/index.js';
import { formatShortcut } from './keys.js';

const DEBOUNCE_MS = 120;

export function createFindBar({ getController, onClose }) {
  const input = h('input.input.find-input', {
    type: 'search',
    role: 'searchbox',
    'aria-label': t('find.label'),
    placeholder: t('find.placeholder'),
    autocomplete: 'off',
    spellcheck: false,
  });
  const counter = h('span.find-count', { role: 'status', 'aria-live': 'polite', id: 'find-count' });
  input.setAttribute('aria-describedby', 'find-count');
  const toggle = (label, text, key) => h('button.btn.find-toggle', {
    type: 'button',
    'aria-pressed': 'false',
    'aria-label': label,
    title: label,
    dataset: { option: key },
  }, text);
  const caseBtn = toggle(t('find.matchCase'), 'Aa', 'matchCase');
  const wordBtn = toggle(t('find.wholeWord'), h('span.find-word-icon', 'ab'), 'wholeWord');
  const navBtn = (name, label, shortcut, onclick) => h('button.btn.icon-btn', {
    type: 'button',
    'aria-label': label,
    title: `${label} (${formatShortcut(shortcut)})`,
    onclick,
  }, icon(name));
  const prevBtn = navBtn('chevronUp', t('find.prev'), 'Mod+Shift+G', () => prev());
  const nextBtn = navBtn('chevronDown', t('find.next'), 'Mod+G', () => next());
  const closeBtn = h('button.btn.icon-btn', {
    type: 'button',
    'aria-label': t('find.close'),
    title: `${t('find.close')} (Esc)`,
    onclick: () => onClose(),
  }, icon('x', { size: 14 }));

  const el = h('div.find-bar', { role: 'search', 'aria-label': t('find.label'), hidden: true },
    icon('search', { size: 14 }), input, counter, caseBtn, wordBtn,
    h('span.find-sep', { 'aria-hidden': 'true' }), prevBtn, nextBtn, closeBtn);

  const options = { matchCase: false, wholeWord: false };
  let controller = null;
  let timer = 0;
  const onUpdate = () => render();

  for (const btn of [caseBtn, wordBtn]) {
    btn.addEventListener('click', () => {
      const key = btn.dataset.option;
      options[key] = !options[key];
      btn.setAttribute('aria-pressed', String(options[key]));
      run();
      input.focus();
    });
  }
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(run, DEBOUNCE_MS);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      // Run a pending search first so Enter never acts on a stale query.
      if (timer) run();
      if (e.shiftKey) prev();
      else next();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  });

  function bind() {
    const c = getController();
    if (c === controller) return;
    controller?.removeEventListener('update', onUpdate);
    controller?.reset();
    controller = c;
    controller?.addEventListener('update', onUpdate);
  }

  function run() {
    clearTimeout(timer);
    timer = 0;
    bind();
    controller?.search(input.value, options);
    render();
  }

  function next() {
    if (timer || controller?.query !== input.value) run();
    controller?.next();
  }

  function prev() {
    if (timer || controller?.query !== input.value) run();
    controller?.prev();
  }

  function render() {
    const s = controller?.state;
    const hasQuery = !!input.value.trim();
    let text = '';
    if (s && hasQuery) {
      if (s.total) text = s.complete ? t('find.count', { n: s.current, m: s.total }) : t('find.countPartial', { n: s.current, m: s.total });
      else text = s.complete ? t('find.none') : t('find.searching');
    }
    counter.textContent = text;
    el.dataset.state = !hasQuery ? 'empty' : s?.total ? 'found' : s?.complete ? 'none' : 'searching';
    prevBtn.disabled = nextBtn.disabled = !s?.total;
  }

  return {
    el,
    get isOpen() {
      return !el.hidden;
    },
    open() {
      el.hidden = false;
      bind();
      const sel = window.getSelection()?.toString().trim();
      if (sel && sel.length < 100 && !sel.includes('\n')) input.value = sel;
      input.focus();
      input.select();
      if (input.value) run();
    },
    close() {
      el.hidden = true;
      clearTimeout(timer);
      controller?.removeEventListener('update', onUpdate);
      controller?.reset();
      controller = null;
    },
    /** The active tab changed while open: search it instead. */
    rebind() {
      if (el.hidden) return;
      bind();
      run();
    },
    next,
    prev,
    input,
  };
}
