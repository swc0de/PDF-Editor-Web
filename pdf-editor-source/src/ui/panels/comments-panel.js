// Comments panel: every markup annotation grouped by page, with threaded
// replies, author and time, edit, reply, resolve / reopen, delete, filters
// (type, author, status) and jump-to. All changes go through app.edit()
// (one undo step each) and write real PDF annotations.
import { h } from '../dom.js';
import { icon } from '../icons.js';
import { t, tn, hasString } from '../../i18n/index.js';
import { implementPanel } from '../panels.js';
import { MARKUP } from '../../view/page-view.js';
import { authorName } from '../../core/settings.js';
import { toViewportRect, isSignature } from '../annotate/annotator.js';

const TYPE_ICONS = {
  Text: 'stickyNote', FreeText: 'textBox', Highlight: 'highlighter', Underline: 'underline', StrikeOut: 'strikethrough',
  Squiggly: 'underline', Square: 'square', Circle: 'circle', Line: 'line', Ink: 'pen', Polygon: 'square', PolyLine: 'line', Stamp: 'stamp', Signature: 'signature',
};
const RESOLVED = new Set(['Completed', 'Accepted']);
const BATCH = 16;

/** Type key used for names and the type filter (our visual signatures get their own). */
const typeKey = (a) => (isSignature(a) ? 'Signature' : a.subtype);
const typeName = (key) => (hasString(`annot.type.${key}`) ? t(`annot.type.${key}`) : key);

function parseDate(pdfjs, s) {
  if (!s) return null;
  try {
    return pdfjs.PDFDateString.toDateObject(s);
  } catch {
    return null;
  }
}

function formatDate(date) {
  if (!date) return '';
  return date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/** Load every page's annotations and build threads: [{ page, root, replies, resolved }]. */
export async function loadThreads(pdf, pdfjs) {
  const n = pdf.numPages;
  const all = [];
  for (let start = 0; start < n; start += BATCH) {
    const chunk = await Promise.all(Array.from({ length: Math.min(BATCH, n - start) }, async (_, k) => {
      const page = start + k;
      try {
        const proxy = await pdf.getPage(page + 1);
        const annots = await proxy.getAnnotations({ intent: 'display' });
        return annots.map((a) => ({ ...a, page }));
      } catch {
        return [];
      }
    }));
    all.push(...chunk.flat());
  }
  const byId = new Map(all.map((a) => [a.id, a]));
  const rootOf = (a) => {
    let cur = a;
    for (let i = 0; i < 20 && cur.inReplyTo && byId.has(cur.inReplyTo); i++) cur = byId.get(cur.inReplyTo);
    return cur;
  };
  const threads = new Map();
  for (const a of all) {
    if (!MARKUP.has(a.subtype) || a.inReplyTo || a.annotationFlags & 2) continue;
    threads.set(a.id, { page: a.page, root: a, replies: [], states: [] });
  }
  for (const a of all) {
    if (!a.inReplyTo || a.replyType === 'Group') continue;
    const thread = threads.get(rootOf(a).id);
    if (!thread) continue;
    if (a.stateModel) thread.states.push(a);
    else thread.replies.push(a);
  }
  const time = (a) => parseDate(pdfjs, a.modificationDate || a.creationDate)?.getTime() ?? 0;
  for (const thread of threads.values()) {
    thread.replies.sort((a, b) => time(a) - time(b));
    const review = thread.states.filter((s) => s.stateModel === 'Review');
    // The latest review state wins (by date, then by order in the file).
    const latest = review.reduce((best, s) => (!best || time(s) >= time(best) ? s : best), null);
    thread.resolved = !!latest && RESOLVED.has(latest.state);
  }
  return [...threads.values()].sort((a, b) => a.page - b.page || b.root.rect[3] - a.root.rect[3] || a.root.rect[0] - b.root.rect[0]);
}

export function registerCommentsPanel() {
  implementPanel('comments', {
    render(container, tab, app) {
      const annotator = app.annotator;
      const pdfjs = tab.viewer.pdfjs;
      let disposed = false;
      let threads = [];
      let editing = null; // { id, mode: 'edit' | 'reply' }
      let loadSeq = 0;
      const filters = { type: '', author: '', status: '' };

      const select = (key, label) => {
        const el = h('select.input.select-sm', {
          'aria-label': label,
          title: label,
          dataset: { filter: key },
          onchange: () => {
            filters[key] = el.value;
            draw();
          },
        });
        return el;
      };
      const typeSel = select('type', t('comments.filterType'));
      const authorSel = select('author', t('comments.filterAuthor'));
      const statusSel = select('status', t('comments.filterStatus'));
      statusSel.append(
        h('option', { value: '' }, t('comments.status.all')),
        h('option', { value: 'open' }, t('comments.status.open')),
        h('option', { value: 'resolved' }, t('comments.status.resolved')));
      const addBtn = h('button.btn.btn-sm', {
        type: 'button',
        title: t('comments.addNoteHint'),
        onclick: () => annotator.activate('note'),
      }, icon('stickyNote', { size: 14 }), t('comments.addNote'));
      const count = h('span.muted.comments-count', { role: 'status' });
      const list = h('div.comments-list', { 'aria-label': t('panel.comments.label') });
      const body = h('div.comments-body', list);
      container.append(
        h('div.panel-toolbar', addBtn, h('span.dialog-spacer'), count),
        h('div.comments-filters', typeSel, authorSel, statusSel),
        body);

      function fillOptions(sel, values, allLabel, labelOf = (v) => v) {
        const current = sel.value;
        sel.replaceChildren(h('option', { value: '' }, allLabel), ...values.map((v) => h('option', { value: v }, labelOf(v))));
        sel.value = values.includes(current) ? current : '';
        filters[sel.dataset.filter] = sel.value;
      }

      async function load() {
        const seq = ++loadSeq;
        const result = await loadThreads(tab.pdf, pdfjs);
        if (disposed || seq !== loadSeq) return;
        threads = result;
        const types = [...new Set(threads.map((th) => typeKey(th.root)))].sort((a, b) => typeName(a).localeCompare(typeName(b)));
        const authors = [...new Set(threads.flatMap((th) => [th.root, ...th.replies].map((a) => a.titleObj?.str || '')))].filter(Boolean).sort();
        fillOptions(typeSel, types, t('comments.type.all'), typeName);
        fillOptions(authorSel, authors, t('comments.author.all'));
        draw();
        // A note just created with the Note tool opens for editing.
        if (annotator.pendingEdit && threads.some((th) => th.root.id === annotator.pendingEdit)) {
          startEdit(annotator.pendingEdit, 'edit');
          annotator.pendingEdit = null;
        }
      }

      function visible() {
        return threads.filter((th) => {
          if (filters.type && typeKey(th.root) !== filters.type) return false;
          if (filters.status === 'open' && th.resolved) return false;
          if (filters.status === 'resolved' && !th.resolved) return false;
          if (filters.author && ![th.root, ...th.replies].some((a) => (a.titleObj?.str || '') === filters.author)) return false;
          return true;
        });
      }

      function startEdit(id, mode) {
        editing = { id, mode };
        draw();
        const area = list.querySelector('.comment-editor textarea');
        area?.focus();
        area?.setSelectionRange(area.value.length, area.value.length);
        area?.closest('.comment-thread')?.scrollIntoView({ block: 'nearest' });
      }

      function editor(thread, initial, mode) {
        const area = h('textarea.input.comment-textarea', {
          rows: 3,
          'aria-label': mode === 'reply' ? t('comments.replyLabel') : t('comments.editLabel'),
          placeholder: mode === 'reply' ? t('comments.replyPlaceholder') : t('comments.editPlaceholder'),
        });
        area.value = initial;
        const save = async () => {
          const text = area.value.trim();
          editing = null;
          const { root, page } = thread;
          if (mode === 'reply') {
            if (text) await app.edit(tab, 'addReply', { page, parent: root.id, contents: text, author: authorName() || t('comments.anonymous') }, t('step.replyComment'));
            else draw();
          } else if (text !== (root.contentsObj?.str ?? '')) {
            await app.edit(tab, 'updateAnnotation', { page, id: root.id, contents: text }, t('step.editComment'));
          } else {
            draw();
          }
        };
        const cancel = () => {
          editing = null;
          draw();
        };
        area.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            save();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            cancel();
          }
        });
        return h('div.comment-editor', area, h('div.comment-editor-actions',
          h('button.btn.btn-sm', { type: 'button', onclick: cancel }, t('common.cancel')),
          h('button.btn.btn-sm.primary', { type: 'button', onclick: save }, mode === 'reply' ? t('comments.reply') : t('comments.save'))));
      }

      function meta(a) {
        const date = parseDate(pdfjs, a.modificationDate || a.creationDate);
        return h('div.comment-meta',
          h('span.comment-author', a.titleObj?.str || t('comments.anonymous')),
          date ? h('time.muted.comment-time', { dateTime: date.toISOString(), title: date.toString() }, formatDate(date)) : null);
      }

      function actionBtn(name, label, onclick, disabled) {
        return h('button.btn.icon-btn.btn-xs', {
          type: 'button', 'aria-label': label, title: label, disabled,
          onclick: (e) => {
            e.stopPropagation();
            onclick();
          },
        }, icon(name, { size: 14 }));
      }

      async function jump(thread) {
        const proxy = await tab.pdf.getPage(thread.page + 1).catch(() => null);
        if (disposed) return;
        let fy = null;
        let fx = null;
        if (proxy) {
          const vp = proxy.getViewport({ scale: 1, rotation: (proxy.rotate + tab.viewer.rotation) % 360 });
          const [x0, y0, x1, y1] = toViewportRect(vp, thread.root.rect);
          fy = Math.max(0, Math.min(y0, y1) / vp.height - 0.08);
          fx = tab.viewer.layout?.scale > 1.5 ? Math.max(0, Math.min(x0, x1) / vp.width - 0.05) : null;
        }
        tab.viewer.navigate(thread.page + 1, { fy, fx });
        annotator.select(thread.page, thread.root.id);
      }

      function threadEl(thread) {
        const { root, replies } = thread;
        const readOnly = !!tab.model.readOnly;
        const isEditing = editing?.id === root.id;
        const contents = root.contentsObj?.str ?? '';
        const selected = annotator.selection?.tabId === tab.id && annotator.selection.id === root.id;
        const actions = h('div.comment-actions',
          actionBtn('reply', t('comments.reply'), () => startEdit(root.id, 'reply'), readOnly),
          actionBtn(thread.resolved ? 'rotateCcw' : 'checkCircle', thread.resolved ? t('comments.reopen') : t('comments.resolve'), () => app.edit(tab, 'setReviewState', {
            page: thread.page, parent: root.id, state: thread.resolved ? 'None' : 'Completed', author: authorName() || t('comments.anonymous'),
          }, thread.resolved ? t('step.reopenComment') : t('step.resolveComment')), readOnly),
          actionBtn('pen', t('comments.edit'), async () => {
            if (root.subtype !== 'FreeText') return startEdit(root.id, 'edit');
            // Text boxes are edited on the page, like Word.
            await jump(thread);
            await tab.viewer.whenAnnotations(thread.page);
            app.annotator.editTextBox(thread.page, root.id);
          }, readOnly),
          actionBtn('trash', t('comments.delete'), () => app.edit(tab, 'deleteAnnotations', { page: thread.page, ids: [root.id] }, t('step.deleteAnnot', { type: typeName(typeKey(root)) })), readOnly));
        const el = h(`div.comment-thread${thread.resolved ? '.resolved' : ''}${selected ? '.selected' : ''}`, {
          role: 'listitem',
          tabIndex: 0,
          dataset: { annotId: root.id, subtype: root.subtype, page: String(thread.page) },
          'aria-label': t('comments.threadLabel', { type: typeName(typeKey(root)), author: root.titleObj?.str || t('comments.anonymous') }),
          onclick: (e) => {
            if (e.target.closest('button, textarea, a')) return;
            jump(thread);
          },
          onkeydown: (e) => {
            if (e.target !== el) return;
            if (e.key === 'Enter') {
              e.preventDefault();
              jump(thread);
            }
          },
        },
        h('div.comment-head',
          h('span.comment-type-icon', { title: typeName(typeKey(root)), style: { color: colorOf(root) } }, icon(TYPE_ICONS[typeKey(root)] ?? 'messageSquare', { size: 14 })),
          meta(root),
          thread.resolved ? h('span.badge.comment-resolved', t('comments.resolvedBadge')) : null,
          actions),
        isEditing && editing.mode === 'edit'
          ? editor(thread, contents, 'edit')
          : h(`p.comment-text${contents ? '' : '.muted'}`, contents || t('comments.noText', { type: typeName(typeKey(root)) })),
        replies.length ? h('div.comment-replies', { role: 'list', 'aria-label': tn('comments.replies', replies.length) }, replies.map((r) => h('div.comment-reply', { role: 'listitem', dataset: { annotId: r.id } },
          h('div.comment-head', h('span.comment-reply-icon', icon('reply', { size: 12 })), meta(r),
            h('div.comment-actions', actionBtn('trash', t('comments.deleteReply'), () => app.edit(tab, 'deleteAnnotations', { page: thread.page, ids: [r.id] }, t('step.deleteReply')), readOnly))),
          h('p.comment-text', r.contentsObj?.str ?? '')))) : null,
        isEditing && editing.mode === 'reply' ? editor(thread, '', 'reply') : null);
        return el;
      }

      function draw() {
        const shown = visible();
        count.textContent = threads.length ? tn('comments.count', threads.length) : '';
        if (!threads.length) {
          body.replaceChildren(h('div.empty-state',
            h('div.empty-icon', icon('messageSquare', { size: 22 })),
            h('p.empty-title', t('comments.none')),
            h('p.empty-text', t('comments.noneText'))));
          return;
        }
        if (!shown.length) {
          body.replaceChildren(h('div.empty-state', h('p.empty-text', t('comments.noMatches'))));
          return;
        }
        const groups = [];
        for (const th of shown) {
          if (groups.at(-1)?.page !== th.page) groups.push({ page: th.page, items: [] });
          groups.at(-1).items.push(th);
        }
        list.replaceChildren(...groups.map((g) => {
          const headingId = `comments-page-${tab.id}-${g.page}`;
          return h('section.comment-group', { 'aria-labelledby': headingId },
            h('h3.comment-page', { id: headingId }, t('comments.page', { label: tab.viewer.pageLabel(g.page) })),
            h('div.comment-group-list', { role: 'list' }, g.items.map(threadEl)));
        }));
        body.replaceChildren(list);
        addBtn.disabled = !!tab.model.readOnly;
      }

      const onDoc = () => load();
      const onSelection = () => {
        for (const el of list.querySelectorAll('.comment-thread')) {
          const on = annotator.selection?.tabId === tab.id && annotator.selection.id === el.dataset.annotId;
          el.classList.toggle('selected', on);
          if (on) el.scrollIntoView({ block: 'nearest' });
        }
      };
      const onEditComment = (e) => {
        if (threads.some((th) => th.root.id === e.detail.id)) {
          annotator.pendingEdit = null;
          startEdit(e.detail.id, 'edit');
        }
      };
      tab.addEventListener('docchange', onDoc);
      tab.model.addEventListener('readonlychange', draw);
      annotator.addEventListener('selectionchange', onSelection);
      annotator.addEventListener('editcomment', onEditComment);
      load();
      return () => {
        disposed = true;
        tab.removeEventListener('docchange', onDoc);
        tab.model.removeEventListener('readonlychange', draw);
        annotator.removeEventListener('selectionchange', onSelection);
        annotator.removeEventListener('editcomment', onEditComment);
      };
    },
  });
}

function colorOf(a) {
  const c = a.subtype === 'FreeText' ? a.defaultAppearanceData?.fontColor ?? a.color : a.color;
  return c && c.length >= 3 ? `rgb(${c[0]}, ${c[1]}, ${c[2]})` : 'var(--text-muted)';
}
