// Signature dialog: draw, type (script-style system fonts) or upload an image,
// or reuse a saved one. Resolves with { png: Uint8Array, width, height } (CSS
// px of the trimmed image) or null. This makes a *visual* signature: a picture
// on the page, not a cryptographic digital signature — the dialog says so.
import { h } from '../dom.js';
import { icon } from '../icons.js';
import { t } from '../../i18n/index.js';
import { createModal } from '../dialog.js';
import { toast } from '../toast.js';
import { authorName } from '../../core/settings.js';
import { listSignatures, saveSignature, removeSignature } from '../../core/signatures.js';
import { canvasToBlob } from '../canvas-encode.js';

export const SCRIPT_FONTS = [
  { id: 'script', css: "'Segoe Script', 'Snell Roundhand', 'Brush Script MT', 'URW Chancery L', cursive" },
  { id: 'hand', css: "'Lucida Handwriting', 'Apple Chancery', 'Z003', cursive" },
  { id: 'print', css: "'Segoe Print', 'Bradley Hand', 'Noteworthy', 'Comic Sans MS', cursive" },
  { id: 'serif', css: "'Palatino Linotype', 'Book Antiqua', Palatino, 'URW Palladio L', serif", italic: true },
];
const INKS = ['#1e2327', '#0b3d91'];
const PAD_W = 520;
const PAD_H = 180;
const SCALE = 3; // device pixels per CSS px for the exported image

/** Trim transparent edges; returns a new canvas (or null if empty). */
export function trimCanvas(src, pad = 4) {
  const ctx = src.getContext('2d');
  const { width, height } = src;
  const data = ctx.getImageData(0, 0, width, height).data;
  let x0 = width;
  let y0 = height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] > 8) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return null;
  x0 = Math.max(0, x0 - pad);
  y0 = Math.max(0, y0 - pad);
  x1 = Math.min(width - 1, x1 + pad);
  y1 = Math.min(height - 1, y1 + pad);
  const out = document.createElement('canvas');
  out.width = x1 - x0 + 1;
  out.height = y1 - y0 + 1;
  out.getContext('2d').drawImage(src, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
  return out;
}

async function canvasToPng(canvas) {
  const blob = await canvasToBlob(canvas, 'image/png');
  return new Uint8Array(await blob.arrayBuffer());
}

async function pngToDataUrl(png) {
  return URL.createObjectURL(new Blob([png], { type: 'image/png' }));
}

export function openSignatureDialog() {
  return new Promise((resolve) => {
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      for (const url of urls) URL.revokeObjectURL(url);
      modal.close();
      resolve(value);
    };
    const urls = [];

    // ---- Draw
    let ink = INKS[0];
    const pad = h('canvas.sig-pad', { width: PAD_W * SCALE, height: PAD_H * SCALE, 'aria-label': t('sign.drawLabel'), role: 'img' });
    const pctx = pad.getContext('2d');
    let strokes = 0;
    const clearPad = () => {
      pctx.clearRect(0, 0, pad.width, pad.height);
      strokes = 0;
      sync();
    };
    pad.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      pad.setPointerCapture(e.pointerId);
      const r = pad.getBoundingClientRect();
      const at = (ev) => [((ev.clientX - r.left) / r.width) * pad.width, ((ev.clientY - r.top) / r.height) * pad.height];
      let last = at(e);
      pctx.strokeStyle = ink;
      pctx.lineWidth = 2.4 * SCALE;
      pctx.lineCap = 'round';
      pctx.lineJoin = 'round';
      pctx.beginPath();
      pctx.arc(last[0], last[1], pctx.lineWidth / 2, 0, Math.PI * 2);
      pctx.fillStyle = ink;
      pctx.fill();
      const move = (ev) => {
        const p = at(ev);
        pctx.beginPath();
        pctx.moveTo(last[0], last[1]);
        pctx.lineTo(p[0], p[1]);
        pctx.stroke();
        last = p;
      };
      const up = () => {
        pad.removeEventListener('pointermove', move);
        pad.removeEventListener('pointerup', up);
        pad.removeEventListener('pointercancel', up);
        strokes++;
        sync();
      };
      pad.addEventListener('pointermove', move);
      pad.addEventListener('pointerup', up);
      pad.addEventListener('pointercancel', up);
    });
    const inkButtons = INKS.map((c, i) => h('button.annot-swatch.sig-ink', {
      type: 'button', 'aria-label': t(i ? 'sign.inkBlue' : 'sign.inkBlack'), title: t(i ? 'sign.inkBlue' : 'sign.inkBlack'), 'aria-pressed': String(i === 0),
      onclick: () => {
        ink = c;
        inkButtons.forEach((b, k) => b.setAttribute('aria-pressed', String(k === i)));
      },
    }));
    inkButtons.forEach((b, i) => b.style.setProperty('--swatch', INKS[i]));
    const drawPanel = h('div.sig-panel', { role: 'tabpanel', id: 'sig-panel-draw', 'aria-labelledby': 'sig-tab-draw' },
      h('div.sig-pad-wrap', pad, h('span.sig-baseline', { 'aria-hidden': 'true' })),
      h('div.sig-row', inkButtons, h('span.dialog-spacer'), h('button.btn.btn-sm', { type: 'button', onclick: clearPad }, t('sign.clear'))));

    // ---- Type
    const typed = h('input.input.sig-type-input', { type: 'text', 'aria-label': t('sign.typeLabel'), placeholder: t('sign.typePlaceholder'), value: authorName(), oninput: () => renderFonts() });
    let fontId = SCRIPT_FONTS[0].id;
    const fontList = h('div.sig-fonts', { role: 'radiogroup', 'aria-label': t('sign.font') });
    const renderFonts = () => {
      fontList.replaceChildren(...SCRIPT_FONTS.map((f) => {
        const b = h('button.sig-font', {
          type: 'button', role: 'radio', 'aria-checked': String(f.id === fontId), dataset: { font: f.id },
          onclick: () => {
            fontId = f.id;
            renderFonts();
            sync();
          },
        }, typed.value || t('sign.typePlaceholder'));
        b.style.fontFamily = f.css;
        if (f.italic) b.style.fontStyle = 'italic';
        return b;
      }));
      sync();
    };
    const typePanel = h('div.sig-panel', { role: 'tabpanel', id: 'sig-panel-type', 'aria-labelledby': 'sig-tab-type', hidden: true }, typed, fontList);

    // ---- Image
    let uploaded = null; // HTMLImageElement
    const fileInput = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif', hidden: true, id: 'sig-file' });
    const preview = h('div.sig-preview');
    const knockout = h('input', { type: 'checkbox', checked: true, onchange: () => showUpload() });
    const showUpload = () => {
      preview.replaceChildren();
      if (uploaded) {
        const c = imageCanvas();
        if (c) preview.append(c);
      } else {
        preview.append(h('span.muted', t('sign.noImage')));
      }
      sync();
    };
    const imageCanvas = () => {
      if (!uploaded) return null;
      const max = 1200;
      const k = Math.min(1, max / Math.max(uploaded.naturalWidth, uploaded.naturalHeight));
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(uploaded.naturalWidth * k));
      c.height = Math.max(1, Math.round(uploaded.naturalHeight * k));
      const ctx = c.getContext('2d');
      ctx.drawImage(uploaded, 0, 0, c.width, c.height);
      if (knockout.checked) {
        // Make near-white pixels transparent (scanned signatures on paper).
        const img = ctx.getImageData(0, 0, c.width, c.height);
        const d = img.data;
        for (let i = 0; i < d.length; i += 4) {
          const light = Math.min(d[i], d[i + 1], d[i + 2]);
          if (light > 235) d[i + 3] = 0;
          else if (light > 200) d[i + 3] = Math.round(d[i + 3] * ((235 - light) / 35));
        }
        ctx.putImageData(img, 0, 0);
      }
      return c;
    };
    fileInput.addEventListener('change', async () => {
      const file = fileInput.files?.[0];
      fileInput.value = '';
      if (!file) return;
      const url = URL.createObjectURL(file);
      urls.push(url);
      const img = new Image();
      img.onload = () => {
        uploaded = img;
        showUpload();
      };
      img.onerror = () => toast(t('sign.badImage'), { kind: 'error' });
      img.src = url;
    });
    const imagePanel = h('div.sig-panel', { role: 'tabpanel', id: 'sig-panel-image', 'aria-labelledby': 'sig-tab-image', hidden: true },
      h('div.sig-row', h('button.btn.btn-sm', { type: 'button', onclick: () => fileInput.click() }, icon('upload', { size: 14 }), t('sign.chooseImage')), fileInput),
      preview,
      h('label.check', knockout, t('sign.removeWhite')));

    // ---- Tabs
    const tabs = ['draw', 'type', 'image'];
    const panels = { draw: drawPanel, type: typePanel, image: imagePanel };
    let mode = 'draw';
    const tabButtons = tabs.map((id) => h('button.sig-tab', {
      type: 'button', role: 'tab', id: `sig-tab-${id}`, 'aria-controls': `sig-panel-${id}`, 'aria-selected': String(id === mode), tabIndex: id === mode ? 0 : -1,
      onclick: () => select(id),
      onkeydown: (e) => {
        if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
        e.preventDefault();
        const next = tabs[(tabs.indexOf(id) + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
        select(next);
        tabButtons[tabs.indexOf(next)].focus();
      },
    }, t(`sign.tab.${id}`)));
    const select = (id) => {
      mode = id;
      tabButtons.forEach((b, i) => {
        b.setAttribute('aria-selected', String(tabs[i] === id));
        b.tabIndex = tabs[i] === id ? 0 : -1;
      });
      for (const [k, p] of Object.entries(panels)) p.hidden = k !== id;
      if (id === 'type') renderFonts();
      sync();
    };

    // ---- Saved
    const savedList = h('div.sig-saved', { role: 'list', 'aria-label': t('sign.saved') });
    const savedBox = h('div.sig-saved-box', h('div.sig-saved-title', t('sign.saved')), savedList);
    savedBox.hidden = true;
    const loadSaved = async () => {
      const list = await listSignatures();
      savedBox.hidden = !list.length;
      savedList.replaceChildren(...await Promise.all(list.map(async (s) => {
        const url = await pngToDataUrl(s.png);
        urls.push(url);
        return h('div.sig-saved-item', { role: 'listitem' },
          h('button.sig-saved-use', { type: 'button', 'aria-label': t('sign.useSaved'), title: t('sign.useSaved'), onclick: () => finish({ png: s.png, width: s.width, height: s.height }) },
            h('img', { src: url, alt: '' })),
          h('button.btn.icon-btn.btn-xs', { type: 'button', 'aria-label': t('sign.deleteSaved'), title: t('sign.deleteSaved'), onclick: async () => { await removeSignature(s.id); loadSaved(); } }, icon('trash', { size: 14 })));
      })));
    };

    const remember = h('input', { type: 'checkbox', checked: true });
    const placeBtn = h('button.btn.primary', { type: 'button', onclick: () => place() }, t('sign.place'));
    const cancelBtn = h('button.btn', { type: 'button', onclick: () => finish(null) }, t('common.cancel'));

    const current = () => {
      if (mode === 'draw') return strokes ? trimCanvas(pad, 2 * SCALE) : null;
      if (mode === 'type') {
        const text = typed.value.trim();
        if (!text) return null;
        const f = SCRIPT_FONTS.find((x) => x.id === fontId);
        const c = document.createElement('canvas');
        const size = 64 * SCALE;
        const ctx = c.getContext('2d');
        const font = `${f.italic ? 'italic ' : ''}${size}px ${f.css}`;
        ctx.font = font;
        c.width = Math.ceil(ctx.measureText(text).width + size);
        c.height = Math.ceil(size * 1.6);
        ctx.font = font;
        ctx.fillStyle = INKS[0];
        ctx.textBaseline = 'middle';
        ctx.fillText(text, size / 2, c.height / 2);
        return trimCanvas(c, 2 * SCALE);
      }
      const c = imageCanvas();
      return c ? trimCanvas(c, 2) : null;
    };
    function sync() {
      placeBtn.disabled = mode === 'draw' ? !strokes : mode === 'type' ? !typed.value.trim() : !uploaded;
    }
    async function place() {
      const c = current();
      if (!c) return;
      const scale = mode === 'image' ? Math.max(1, Math.max(c.width / 600, c.height / 200)) : SCALE;
      const result = { png: await canvasToPng(c), width: c.width / scale, height: c.height / scale };
      if (remember.checked) await saveSignature(result).catch(() => {});
      finish(result);
    }

    const modal = createModal({
      title: t('sign.title'),
      className: 'sig-dialog',
      onCancel: () => finish(null),
      body: [
        h('p.sig-note', icon('info', { size: 14 }), h('span', t('sign.visualNote'))),
        savedBox,
        h('div.sig-tabs', { role: 'tablist', 'aria-label': t('sign.title') }, tabButtons),
        drawPanel, typePanel, imagePanel,
        h('label.check', remember, t('sign.remember')),
      ],
      footer: [cancelBtn, placeBtn],
    });
    showUpload();
    sync();
    loadSaved();
  });
}
