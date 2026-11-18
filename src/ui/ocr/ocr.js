// Recognize text (OCR): options dialog → OCR in workers with per-page
// progress (cancellable) → Verify screen → "Apply" adds an invisible text
// layer (one undo step), so the document can be searched and copied.
import { h } from '../dom.js';
import { t, tn } from '../../i18n/index.js';
import { openDialog, createModal } from '../dialog.js';
import { toast } from '../toast.js';
import { getPref, setPref } from '../../core/prefs.js';
import { parsePageRange } from '../../core/page-range.js';
import { OCR_LANGUAGES } from '../../core/libs.config.js';
import { createOcrEngine, preloadLanguage } from '../../core/ocr.js';
import { ocrPage, wordsToPdf } from './ocr-run.js';
import { openVerify } from './verify.js';

const OPTION_KEYS = ['autoRotate', 'deskew', 'denoise', 'binarize'];
const DEFAULT_OPTIONS = { autoRotate: false, deskew: true, denoise: true, binarize: true, skipText: true };

export class Ocr {
  constructor(app) {
    this.app = app;
    this.running = false;
  }

  async start() {
    const tab = this.app.editableTab();
    if (!tab || this.running) return;
    const choice = await this.askOptions(tab);
    if (!choice) return;
    this.running = true;
    try {
      await this.run(tab, choice);
    } finally {
      this.running = false;
    }
  }

  askOptions(tab) {
    const count = tab.pdf.numPages;
    const current = tab.viewer.current + 1;
    const saved = { ...DEFAULT_OPTIONS, ...getPref('ocr.options', {}) };
    const range = h('input.input', { type: 'text', name: 'range', placeholder: t('print.rangePlaceholder'), autocomplete: 'off', disabled: true });
    const radio = (value, label, checked) => h('label.radio', h('input', { type: 'radio', name: 'which', value, checked }), label);
    // Long documents default to the current page (OCR takes a few seconds per page).
    const which = h('fieldset.radio-group', h('legend', t('ocr.pages')),
      radio('all', t('print.all', { n: count }), count <= 20),
      radio('current', t('print.current', { n: current }), count > 20),
      radio('range', t('print.range')), range);
    which.addEventListener('change', () => {
      range.disabled = !which.querySelector('input[value="range"]').checked;
      if (!range.disabled) range.focus();
    });
    const lang = h('select.input', { name: 'lang', 'aria-label': t('ocr.language') },
      OCR_LANGUAGES.map((code) => h('option', { value: code }, t(`ocr.lang.${code}`))));
    lang.value = getPref('ocr.lang', 'eng');
    const box = (key) => h('label.check', h('input', { type: 'checkbox', name: key, checked: !!saved[key] }), t(`ocr.opt.${key}`));
    const error = h('p.field-error', { role: 'alert' });
    return openDialog({
      title: t('ocr.title'),
      className: 'ocr-dialog',
      body: [
        which,
        h('label.field', h('span.field-label', t('ocr.language')), lang, h('span.field-help', t('ocr.languageHelp'))),
        h('fieldset.ocr-options', h('legend', t('ocr.preprocess')), OPTION_KEYS.map(box)),
        box('skipText'),
        error,
      ],
      actions: [{ label: t('common.cancel'), value: null }, { label: t('ocr.start'), primary: true }],
      onSubmit: (form) => {
        const f = new FormData(form);
        let pages;
        if (f.get('which') === 'current') pages = [current - 1];
        else if (f.get('which') === 'range') {
          const r = parsePageRange(range.value, count);
          if (r.error) {
            error.textContent = t('print.badRange', { part: r.error });
            return undefined;
          }
          pages = r.pages;
        } else pages = [...Array(count).keys()];
        const options = Object.fromEntries([...OPTION_KEYS, 'skipText'].map((k) => [k, !!f.get(k)]));
        setPref('ocr.options', options);
        setPref('ocr.lang', f.get('lang'));
        return { pages, lang: String(f.get('lang')), options };
      },
    });
  }

  /** Pages that already have text (a scan has none). */
  async pagesWithText(tab, pages) {
    const out = new Set();
    for (const i of pages) {
      try {
        const content = await (await tab.pdf.getPage(i + 1)).getTextContent();
        if (content.items.some((it) => it.str && it.str.trim())) out.add(i);
      } catch {
        /* treat as no text */
      }
    }
    return out;
  }

  async run(tab, { pages: requested, lang, options }) {
    let pages = requested;
    if (options.skipText) {
      const withText = await this.pagesWithText(tab, requested);
      pages = requested.filter((i) => !withText.has(i));
      if (!pages.length) {
        toast(t('ocr.allHaveText'));
        return;
      }
    }
    // Progress window: one row per page.
    let cancelled = false;
    let engine = null;
    const status = h('p.ocr-status', { role: 'status' }, t('ocr.loading'));
    const overall = h('progress', { max: pages.length, value: 0, 'aria-label': t('ocr.progressOverall') });
    const rows = new Map(pages.map((i) => {
      const bar = h('progress', { max: 1, value: 0 });
      const state = h('span.ocr-row-state', t('ocr.queued'));
      const row = h('li.ocr-row', h('span.ocr-row-page', t('ocr.pageN', { label: tab.viewer.pageLabel(i) })), bar, state);
      return [i, { row, bar, state }];
    }));
    const cancel = () => {
      cancelled = true;
      engine?.terminate();
    };
    const modal = createModal({
      title: t('ocr.running'),
      className: 'ocr-progress',
      body: [status, overall, h('ol.ocr-rows', [...rows.values()].map((r) => r.row))],
      footer: [h('button.btn', { type: 'button', onclick: cancel }, t('common.cancel'))],
      onCancel: cancel,
    });
    const results = [];
    try {
      await preloadLanguage(lang);
      if (cancelled) return;
      status.textContent = t('ocr.starting');
      const workers = Math.max(1, Math.min(2, (navigator.hardwareConcurrency || 2) - 1, pages.length));
      engine = await createOcrEngine([lang], { workers });
      if (cancelled) return;
      status.textContent = t('ocr.recognizing');
      let done = 0;
      const queue = [...pages];
      const runOne = async () => {
        while (queue.length && !cancelled) {
          const i = queue.shift();
          const r = rows.get(i);
          r.state.textContent = t('ocr.preparing');
          try {
            const res = await ocrPage(tab, i, engine, options, (phase, p) => {
              if (phase === 'recognize') {
                r.bar.value = 0.1 + 0.9 * p;
                r.state.textContent = t('ocr.percent', { n: Math.round(p * 100) });
              } else {
                r.bar.value = p;
              }
            });
            results.push(res);
            r.bar.value = 1;
            r.state.textContent = tn('ocr.wordsFound', res.words.length);
            r.row.classList.add('done');
          } catch (err) {
            if (cancelled) return;
            r.state.textContent = t('ocr.pageFailed');
            r.row.classList.add('failed');
            console.warn('[ocr] page failed', i + 1, err);
          }
          overall.value = ++done;
        }
      };
      await Promise.all(Array.from({ length: engine.size }, runOne));
      if (cancelled) return;
    } catch (err) {
      if (!cancelled) toast(t('ocr.failed', { message: err.message }), { kind: 'error' });
      cancelled = true;
    } finally {
      modal.close();
      if (cancelled) {
        await engine?.terminate();
        for (const r of results) URL.revokeObjectURL(r.url);
      }
    }
    if (cancelled) return;
    results.sort((a, b) => a.page - b.page);
    if (!results.length) {
      await engine.terminate();
      toast(t('ocr.nothing'), { kind: 'error' });
      return;
    }
    try {
      const verified = await openVerify({ app: this.app, tab, results, engine, options });
      if (!verified) return;
      const payload = [];
      for (const res of verified) {
        const proxy = await tab.pdf.getPage(res.page + 1);
        const viewport = proxy.getViewport({ scale: res.scale, rotation: res.rotation });
        payload.push({ page: res.page, words: wordsToPdf(res, viewport) });
      }
      const value = await this.app.edit(tab, 'addTextLayer', { pages: payload }, t('step.ocr'));
      if (value) toast(t('ocr.applied', { words: tn('ocr.words', value.words), pages: tn('redact.pages', payload.length) }));
    } finally {
      await engine.terminate();
      for (const r of results) URL.revokeObjectURL(r.url);
    }
  }
}
