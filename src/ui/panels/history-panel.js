// Undo History panel: every step of the active document; click one to go
// back (or forward) to exactly that state.
import { h } from '../dom.js';
import { icon } from '../icons.js';
import { t } from '../../i18n/index.js';
import { implementPanel } from '../panels.js';
import { formatShortcut } from '../keys.js';

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });

export function registerHistoryPanel() {
  implementPanel('history', {
    render(container, tab) {
      const model = tab.model;
      const undoBtn = h('button.btn.btn-sm', {
        type: 'button',
        title: `${t('command.edit.undo')} (${formatShortcut('Mod+Z')})`,
        onclick: () => model.undo(),
      }, icon('undo', { size: 14 }), t('command.edit.undo'));
      const redoBtn = h('button.btn.btn-sm', {
        type: 'button',
        title: `${t('command.edit.redo')} (${formatShortcut('Mod+Shift+Z')})`,
        onclick: () => model.redo(),
      }, icon('redo', { size: 14 }), t('command.edit.redo'));
      const list = h('ol.history-list', { role: 'listbox', 'aria-label': t('panel.history.label') });
      const note = h('p.muted.history-note');
      container.append(h('div.panel-toolbar', undoBtn, redoBtn), h('div.history-scroller', note, list));

      function render() {
        const { entries, index, trimmed } = model.history;
        undoBtn.disabled = !model.canUndo;
        redoBtn.disabled = !model.canRedo;
        note.hidden = !trimmed;
        note.textContent = trimmed ? t('history.trimmed', { n: trimmed }) : '';
        list.replaceChildren(...entries.map((entry, i) => {
          const isCurrent = i === index;
          const saved = entry === model.savedEntry;
          return h(`li.history-item${i > index ? '.future' : ''}`, {
            role: 'option',
            tabindex: isCurrent ? '0' : '-1',
            'aria-selected': String(isCurrent),
            'aria-current': isCurrent ? 'step' : null,
            dataset: { index: String(i) },
          },
            icon(entry.initial ? 'file' : 'history', { size: 14 }),
            h('span.history-label', entry.label),
            saved ? h('span.badge.history-saved', t('history.saved')) : null,
            h('time.history-time', timeFmt.format(entry.time)),
          );
        }));
        list.querySelector('[aria-current]')?.scrollIntoView({ block: 'nearest' });
      }

      list.addEventListener('click', (e) => {
        const li = e.target.closest('.history-item');
        if (li) model.jumpTo(model.history.entries[Number(li.dataset.index)]);
      });
      list.addEventListener('keydown', (e) => {
        const li = e.target.closest('.history-item');
        if (!li) return;
        const i = Number(li.dataset.index);
        const target = { ArrowUp: i - 1, ArrowDown: i + 1, Home: 0, End: model.history.entries.length - 1 }[e.key];
        if (target !== undefined) {
          e.preventDefault();
          const items = list.querySelectorAll('.history-item');
          items[Math.max(0, Math.min(items.length - 1, target))]?.focus();
        } else if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          model.jumpTo(model.history.entries[i]).then(() => list.querySelector(`[data-index="${i}"]`)?.focus());
        }
      });

      const onChange = () => render();
      model.addEventListener('historychange', onChange);
      model.addEventListener('dirtychange', onChange);
      render();
      return () => {
        model.removeEventListener('historychange', onChange);
        model.removeEventListener('dirtychange', onChange);
      };
    },
  });
}
