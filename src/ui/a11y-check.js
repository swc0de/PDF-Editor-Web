// Accessibility Checker: tagged status, title and language, figures without
// alternative text, form fields without an accessible name, bookmarks in long
// documents, and pages with no text (scans). Each check passes, fails or
// warns; issues link to their pages, and the ones PDF Editor can fix have a
// button to fix them (each fix is an undo step), then the report refreshes.
import { h } from './dom.js';
import { icon } from './icons.js';
import { t, tn } from '../i18n/index.js';
import { createModal } from './dialog.js';
import { toast } from './toast.js';

const LANGS = ['en', 'en-US', 'en-GB', 'de', 'fr', 'es', 'it', 'pt', 'nl', 'da', 'sv', 'nb', 'fi', 'ca', 'pl', 'cs', 'ru', 'ja', 'zh', 'ko', 'ar'];
const LONG_DOCUMENT = 20;
const MAX_LISTED = 25;

/** Run every check. Resolves [{ id, status: 'pass'|'fail'|'warn'|'na', title, detail, items?, fix? }]. */
export async function runChecks(tab, onProgress) {
  const info = await tab.model.query('accessibilityInfo', {});
  const meta = await tab.pdf.getMetadata().catch(() => null);
  const title = info.title || meta?.metadata?.get?.('dc:title') || '';
  // Pages with no text at all (usually scans).
  const textless = [];
  for (let i = 0; i < tab.pdf.numPages; i++) {
    if (i % 10 === 0) onProgress?.(i, tab.pdf.numPages);
    try {
      const content = await (await tab.pdf.getPage(i + 1)).getTextContent();
      if (!content.items.some((it) => it.str && it.str.trim())) textless.push(i);
    } catch {
      /* a broken page is reported by the viewer itself */
    }
  }
  const checks = [];
  checks.push({
    id: 'tagged',
    status: info.tagged && info.marked ? 'pass' : 'fail',
    title: t(info.tagged && info.marked ? 'a11y.tagged.pass' : 'a11y.tagged.fail'),
    detail: info.tagged && info.marked ? '' : t('a11y.tagged.detail'),
  });
  checks.push({
    id: 'title',
    status: title ? 'pass' : 'fail',
    title: title ? t('a11y.title.pass', { title }) : t('a11y.title.fail'),
    detail: title ? '' : t('a11y.title.detail'),
    fix: title ? null : { kind: 'title' },
  });
  if (title && !info.displayDocTitle) {
    checks.push({ id: 'displayTitle', status: 'warn', title: t('a11y.displayTitle.warn'), detail: t('a11y.displayTitle.detail'), fix: { kind: 'displayTitle' } });
  }
  checks.push({
    id: 'lang',
    status: info.lang ? 'pass' : 'fail',
    title: info.lang ? t('a11y.lang.pass', { lang: info.lang }) : t('a11y.lang.fail'),
    detail: info.lang ? '' : t('a11y.lang.detail'),
    fix: info.lang ? null : { kind: 'lang' },
  });
  if (info.tagged) {
    const missing = info.figures.filter((f) => !f.alt);
    checks.push({
      id: 'alt',
      status: !info.figures.length ? 'na' : missing.length ? 'fail' : 'pass',
      title: !info.figures.length ? t('a11y.alt.none') : missing.length ? tn('a11y.alt.fail', missing.length) : tn('a11y.alt.pass', info.figures.length),
      detail: missing.length ? t('a11y.alt.detail') : '',
      items: missing.map((f) => ({ page: f.page, text: f.page === null ? t('a11y.alt.itemNoPage') : t('a11y.alt.item', { page: tab.viewer.pageLabel(f.page) }) })),
    });
  } else {
    checks.push({
      id: 'alt',
      status: info.imagePages.length ? 'warn' : 'na',
      title: info.imagePages.length ? tn('a11y.altUntagged.warn', info.imagePages.length) : t('a11y.alt.none'),
      detail: info.imagePages.length ? t('a11y.altUntagged.detail') : '',
      items: info.imagePages.map((p) => ({ page: p, text: t('a11y.page', { page: tab.viewer.pageLabel(p) }) })),
    });
  }
  const unnamed = info.fields.filter((f) => !f.tooltip);
  checks.push({
    id: 'fields',
    status: !info.fields.length ? 'na' : unnamed.length ? 'fail' : 'pass',
    title: !info.fields.length ? t('a11y.fields.none') : unnamed.length ? tn('a11y.fields.fail', unnamed.length) : tn('a11y.fields.pass', info.fields.length),
    detail: unnamed.length ? t('a11y.fields.detail') : '',
    items: unnamed.map((f) => ({
      page: f.page,
      text: f.page === null ? t('a11y.fields.itemNoPage', { name: f.name }) : t('a11y.fields.item', { name: f.name, page: tab.viewer.pageLabel(f.page) }),
      fix: { kind: 'field', name: f.name },
    })),
  });
  const long = info.pageCount > LONG_DOCUMENT;
  checks.push({
    id: 'bookmarks',
    status: info.hasOutline ? 'pass' : long ? 'fail' : 'na',
    title: info.hasOutline ? t('a11y.bookmarks.pass') : long ? t('a11y.bookmarks.fail', { n: info.pageCount }) : t('a11y.bookmarks.short'),
    detail: !info.hasOutline && long ? t('a11y.bookmarks.detail') : '',
  });
  checks.push({
    id: 'text',
    status: textless.length ? 'warn' : 'pass',
    title: textless.length ? tn('a11y.text.warn', textless.length) : t('a11y.text.pass'),
    detail: textless.length ? t('a11y.text.detail') : '',
    items: textless.map((p) => ({ page: p, text: t('a11y.page', { page: tab.viewer.pageLabel(p) }) })),
    fix: textless.length ? { kind: 'ocr' } : null,
  });
  return checks;
}

const STATUS_ICON = { pass: 'check', fail: 'x', warn: 'alertTriangle', na: 'minus' };

export async function openAccessibilityCheck(app) {
  const tab = app.activeTab;
  if (!tab) return toast(t('a11y.needsDocument'));
  const summary = h('p.a11y-summary', { role: 'status', 'aria-live': 'polite' }, t('a11y.checking'));
  const list = h('ul.a11y-checks', { 'aria-label': t('a11y.results') });
  let closed = false;
  const modal = createModal({
    title: t('a11y.title'),
    className: 'a11y-dialog',
    onCancel: () => close(),
    body: [summary, list],
    footer: [
      h('button.btn', { type: 'button', onclick: () => refresh() }, icon('rotateCw', { size: 14 }), t('a11y.recheck')),
      h('button.btn.primary', { type: 'button', onclick: () => close() }, t('common.close')),
    ],
  });
  function close() {
    closed = true;
    modal.close();
  }

  const goTo = (page) => {
    close();
    tab.viewer.navigate(page + 1);
  };

  async function fix(f, row) {
    const readOnly = tab.model.readOnly;
    if (readOnly && f.kind !== 'ocr') {
      toast(t(`edit.readOnly.${readOnly}`), { kind: 'error' });
      return;
    }
    if (f.kind === 'title') {
      close();
      app.showPanel('properties');
      // The panel renders asynchronously: focus Title once it's there.
      let tries = 0;
      const focusTitle = () => {
        const input = document.querySelector('#side-panel input[name="title"]');
        if (input) input.focus();
        else if (++tries < 60) requestAnimationFrame(focusTitle);
      };
      requestAnimationFrame(focusTitle);
      return;
    }
    if (f.kind === 'displayTitle') {
      if (await app.edit(tab, 'setDisplayDocTitle', {}, t('step.displayDocTitle'))) refresh();
      return;
    }
    if (f.kind === 'lang') {
      const input = row.querySelector('input[name="lang"]');
      const lang = input.value.trim();
      if (!/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(lang)) {
        input.setAttribute('aria-invalid', 'true');
        row.querySelector('.field-error').textContent = t('a11y.lang.invalid');
        input.focus();
        return;
      }
      if (await app.edit(tab, 'setLanguage', { lang }, t('step.setLanguage', { lang }))) refresh();
      return;
    }
    if (f.kind === 'field') {
      const result = await app.formEditor.editProperties(f.name);
      if (result) refresh();
      return;
    }
    if (f.kind === 'ocr') {
      close();
      app.ocr.start();
    }
  }

  function fixButton(f, row) {
    const label = { title: 'a11y.fix.title', displayTitle: 'a11y.fix.displayTitle', lang: 'a11y.fix.lang', field: 'a11y.fix.field', ocr: 'a11y.fix.ocr' }[f.kind];
    return h('button.btn.btn-sm', { type: 'button', onclick: () => fix(f, row) }, t(label));
  }

  function render(checks) {
    const count = (s) => checks.filter((c) => c.status === s).length;
    summary.textContent = t('a11y.summary', { pass: count('pass'), fail: count('fail'), warn: count('warn') });
    list.replaceChildren(...checks.map((c) => {
      const row = h(`li.a11y-check.status-${c.status}`, { dataset: { check: c.id } });
      const head = h('div.a11y-head',
        h('span.a11y-icon', { 'aria-hidden': 'true' }, icon(STATUS_ICON[c.status], { size: 14 })),
        h('span.visually-hidden', t(`a11y.status.${c.status}`)),
        h('span.a11y-title', c.title));
      row.append(head);
      if (c.detail) row.append(h('p.a11y-detail', c.detail));
      if (c.fix?.kind === 'lang') {
        const id = 'a11y-lang-options';
        row.append(h('div.a11y-fix-lang',
          h('label.visually-hidden', { htmlFor: 'a11y-lang' }, t('a11y.lang.label')),
          h('input.input', { id: 'a11y-lang', name: 'lang', list: id, value: navigator.language || 'en', autocomplete: 'off', 'aria-label': t('a11y.lang.label') }),
          h('datalist', { id }, LANGS.map((l) => h('option', { value: l }))),
          fixButton(c.fix, row),
          h('span.field-error', { role: 'alert' })));
      } else if (c.fix) {
        row.append(h('div.a11y-actions', fixButton(c.fix, row)));
      }
      if (c.items?.length) {
        const shown = c.items.slice(0, MAX_LISTED);
        row.append(h('ul.a11y-items', shown.map((it) => h('li.a11y-item',
          h('span', it.text),
          it.page !== null && it.page !== undefined
            ? h('button.btn-link', { type: 'button', onclick: () => goTo(it.page) }, t('a11y.goTo', { page: tab.viewer.pageLabel(it.page) }))
            : null,
          it.fix ? fixButton(it.fix, row) : null)),
        c.items.length > shown.length ? h('li.muted', tn('a11y.more', c.items.length - shown.length)) : null));
      }
      return row;
    }));
  }

  async function refresh() {
    summary.textContent = t('a11y.checking');
    try {
      const checks = await runChecks(tab, (i, n) => {
        if (!closed) summary.textContent = t('a11y.progress', { n: i + 1, total: n });
      });
      if (!closed) render(checks);
    } catch (err) {
      if (!closed) {
        summary.textContent = tab.model.readOnly === 'encrypted' ? t('a11y.encrypted') : t('a11y.failed', { message: err.message });
        list.replaceChildren();
      }
    }
  }
  refresh();
}
