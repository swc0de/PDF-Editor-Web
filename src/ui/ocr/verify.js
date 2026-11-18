// OCR Verify screen: the page image with every recognized word overlaid and
// coloured by confidence (green ≥ 85, amber ≥ 60, red below). Click a word to
// correct it (corrections go into the user dictionary and are applied to later
// OCR runs), draw a box to re-OCR a region, or re-OCR the whole page.
// Resolves the (edited) results, or null if cancelled.
import { h } from '../dom.js';
import { icon } from '../icons.js';
import { t, tn } from '../../i18n/index.js';
import { createModal } from '../dialog.js';
import { toast } from '../toast.js';
import { ocrPage, ocrRegion, learnCorrection, getDictionary, clearDictionary } from './ocr-run.js';

export const confidenceClass = (c) => (c >= 85 ? 'conf-high' : c >= 60 ? 'conf-mid' : 'conf-low');

export function openVerify({ app, tab, results, engine, options }) {
  return new Promise((resolve) => {
    let index = 0;
    let busy = false;
    let regionMode = false;
    let finished = false;

    const finish = (value) => {
      if (finished) return;
      finished = true;
      modal.close();
      resolve(value);
    };

    // ---- header
    const pageLabel = h('span.ocr-page-label', { role: 'status', 'aria-live': 'polite' });
    const prev = h('button.btn.icon-btn', { type: 'button', 'aria-label': t('ocr.prevPage'), title: t('ocr.prevPage'), onclick: () => show(index - 1) }, icon('chevronLeft'));
    const next = h('button.btn.icon-btn', { type: 'button', 'aria-label': t('ocr.nextPage'), title: t('ocr.nextPage'), onclick: () => show(index + 1) }, icon('chevronRight'));
    const stats = h('span.ocr-stats');
    const legend = h('span.ocr-legend', { 'aria-hidden': 'true' },
      h('span.ocr-key.conf-high', t('ocr.confHigh')), h('span.ocr-key.conf-mid', t('ocr.confMid')), h('span.ocr-key.conf-low', t('ocr.confLow')));
    const nextLow = h('button.btn.btn-sm', { type: 'button', onclick: () => focusNextLow() }, t('ocr.nextLow'));
    const regionBtn = h('button.btn.btn-sm', { type: 'button', 'aria-pressed': 'false', onclick: () => setRegionMode(!regionMode) }, icon('scanText', { size: 14 }), t('ocr.reocrArea'));
    const pageBtn = h('button.btn.btn-sm', { type: 'button', onclick: () => reocrPage() }, icon('rotateCw', { size: 14 }), t('ocr.reocrPage'));
    const dict = h('span.muted.ocr-dict');
    const dictClear = h('button.btn-link', { type: 'button', onclick: () => { clearDictionary(); syncDict(); } }, t('ocr.clearDictionary'));

    // ---- stage
    const img = h('img.ocr-image', { alt: '' });
    const overlay = h('div.ocr-words', { role: 'group', 'aria-label': t('ocr.wordsLabel') });
    const draft = h('div.ocr-region', { hidden: true, 'aria-hidden': 'true' });
    const figure = h('div.ocr-figure', img, overlay, draft);
    const stage = h('div.ocr-stage', figure);
    const busyNote = h('div.ocr-busy', { hidden: true, role: 'status' }, t('ocr.working'));

    const modal = createModal({
      title: t('ocr.verifyTitle'),
      className: 'ocr-verify',
      onCancel: () => finish(null),
      body: [
        h('div.ocr-toolbar',
          h('div.ocr-nav', prev, pageLabel, next),
          legend, stats, nextLow,
          h('span.dialog-spacer'),
          regionBtn, pageBtn),
        h('p.muted.ocr-help', t('ocr.verifyHelp'), ' ', dict, ' ', dictClear),
        stage, busyNote,
      ],
      footer: [
        h('button.btn', { type: 'button', onclick: () => finish(null) }, t('common.cancel')),
        h('button.btn.primary', { type: 'button', onclick: () => finish(results) }, t('ocr.apply')),
      ],
    });

    function syncDict() {
      const n = Object.keys(getDictionary().corrections).length;
      dict.textContent = tn('ocr.dictionary', n);
      dictClear.hidden = !n;
    }

    function show(i) {
      if (i < 0 || i >= results.length || busy) return;
      index = i;
      const res = results[index];
      prev.disabled = index === 0;
      next.disabled = index === results.length - 1;
      pageLabel.textContent = t('ocr.verifyPage', { label: tab.viewer.pageLabel(res.page), n: index + 1, total: results.length });
      img.src = res.url;
      figure.style.aspectRatio = `${res.wB} / ${res.hB}`;
      renderWords();
    }

    function renderWords() {
      const res = results[index];
      const low = res.words.filter((w) => w.confidence < 85 && !w.corrected).length;
      stats.textContent = `${tn('ocr.words', res.words.length)} · ${tn('ocr.lowCount', low)}`;
      nextLow.disabled = !low;
      overlay.replaceChildren(...res.words.map((w, k) => {
        const [x0, y0, x1, y1] = w.bbox;
        const cls = w.corrected || w.fromDictionary ? 'corrected' : confidenceClass(w.confidence);
        const b = h(`button.ocr-word.${cls}`, {
          type: 'button',
          dataset: { k: String(k) },
          title: w.corrected ? t('ocr.wordCorrected', { text: w.text }) : t('ocr.wordConfidence', { text: w.text, n: w.confidence }),
          'aria-label': w.corrected ? t('ocr.wordCorrected', { text: w.text }) : t('ocr.wordConfidence', { text: w.text, n: w.confidence }),
          onclick: () => edit(k),
        });
        Object.assign(b.style, {
          left: `${(x0 / res.wB) * 100}%`,
          top: `${(y0 / res.hB) * 100}%`,
          width: `${((x1 - x0) / res.wB) * 100}%`,
          height: `${((y1 - y0) / res.hB) * 100}%`,
        });
        return b;
      }));
    }

    function edit(k) {
      if (regionMode || busy) return;
      const res = results[index];
      const w = res.words[k];
      const btn = overlay.querySelector(`[data-k="${k}"]`);
      const input = h('input.input.ocr-edit', { type: 'text', value: w.text, 'aria-label': t('ocr.correctWord'), spellcheck: false });
      Object.assign(input.style, { left: btn.style.left, top: btn.style.top, minWidth: btn.style.width });
      overlay.append(input);
      input.focus();
      input.select();
      let done = false;
      const commit = (save) => {
        if (done) return;
        done = true;
        const text = input.value.trim();
        input.remove();
        if (save && text && text !== w.text) {
          learnCorrection(w.original ?? w.text, text);
          w.original ??= w.text;
          w.text = text;
          w.corrected = true;
          syncDict();
        }
        renderWords();
        overlay.querySelector(`[data-k="${k}"]`)?.focus();
      };
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          commit(true);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          commit(false);
        }
      });
      input.addEventListener('blur', () => commit(true));
    }

    function focusNextLow() {
      const res = results[index];
      const active = Number(document.activeElement?.dataset?.k ?? -1);
      const order = res.words.map((w, k) => k).filter((k) => res.words[k].confidence < 85 && !res.words[k].corrected);
      const k = order.find((x) => x > active) ?? order[0];
      if (k !== undefined) overlay.querySelector(`[data-k="${k}"]`)?.focus();
    }

    function setBusy(b) {
      busy = b;
      busyNote.hidden = !b;
      for (const btn of [regionBtn, pageBtn, prev, next]) btn.disabled = b || (btn === prev && index === 0) || (btn === next && index === results.length - 1);
    }

    function setRegionMode(on) {
      regionMode = on;
      regionBtn.setAttribute('aria-pressed', String(on));
      stage.classList.toggle('region-mode', on);
    }

    async function reocrPage() {
      setBusy(true);
      try {
        const old = results[index];
        const res = await ocrPage(tab, old.page, engine, options);
        URL.revokeObjectURL(old.url);
        results[index] = res;
        show(index);
      } catch (err) {
        toast(t('ocr.failed', { message: err.message }), { kind: 'error' });
      } finally {
        setBusy(false);
      }
    }

    // Draw a box to re-OCR that region.
    figure.addEventListener('pointerdown', (e) => {
      if (!regionMode || busy || e.button !== 0) return;
      e.preventDefault();
      const r = figure.getBoundingClientRect();
      const res = results[index];
      const toImg = (ev) => [((ev.clientX - r.left) / r.width) * res.wB, ((ev.clientY - r.top) / r.height) * res.hB];
      const start = toImg(e);
      let end = start;
      const place = () => {
        const [x0, y0, x1, y1] = [Math.min(start[0], end[0]), Math.min(start[1], end[1]), Math.max(start[0], end[0]), Math.max(start[1], end[1])];
        draft.hidden = false;
        Object.assign(draft.style, { left: `${(x0 / res.wB) * 100}%`, top: `${(y0 / res.hB) * 100}%`, width: `${((x1 - x0) / res.wB) * 100}%`, height: `${((y1 - y0) / res.hB) * 100}%` });
      };
      const move = (ev) => {
        end = toImg(ev);
        place();
      };
      const up = async () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        draft.hidden = true;
        const box = [Math.min(start[0], end[0]), Math.min(start[1], end[1]), Math.max(start[0], end[0]), Math.max(start[1], end[1])];
        if (box[2] - box[0] < 8 || box[3] - box[1] < 8) return;
        setBusy(true);
        try {
          const words = await ocrRegion(res, engine, box);
          const inside = (w) => {
            const cx = (w.bbox[0] + w.bbox[2]) / 2;
            const cy = (w.bbox[1] + w.bbox[3]) / 2;
            return cx >= box[0] && cx <= box[2] && cy >= box[1] && cy <= box[3];
          };
          res.words = [...res.words.filter((w) => !inside(w)), ...words.filter(inside)]
            .sort((a, b) => a.bbox[1] - b.bbox[1] || a.bbox[0] - b.bbox[0]);
          renderWords();
          toast(tn('ocr.regionDone', words.filter(inside).length));
        } catch (err) {
          toast(t('ocr.failed', { message: err.message }), { kind: 'error' });
        } finally {
          setBusy(false);
          setRegionMode(false);
        }
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });

    syncDict();
    show(0);
  });
}
