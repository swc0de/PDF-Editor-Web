// Page thumbnails, cached per tab as compressed image URLs.
//
// The cache key is the PDF page object (num/gen) plus its displayed rotation,
// not the page index — so after pages are reordered, deleted or inserted, the
// thumbnails of pages that didn't change are reused. Operations that change a
// page's *content* report it in `affected`, and those entries are dropped.

import { canvasToBlob } from './canvas-encode.js';

const RENDER_WIDTH = 180; // CSS px; smaller sizes scale down
/** Most thumbnails kept per tab (least recently used ones are dropped). */
export const MAX_THUMBS = 600;

function state(tab) {
  if (!tab.thumbs) {
    tab.thumbs = new Map(); // key → object URL
    tab.thumbKeys = []; // page index → key (as last rendered)
    tab.addEventListener('destroy', () => {
      for (const url of tab.thumbs.values()) URL.revokeObjectURL(url);
      tab.thumbs.clear();
    });
  }
  return tab;
}

/** Object URL of page `index`'s thumbnail (rendered if not cached). */
export async function getThumb(tab, index) {
  state(tab);
  const page = await tab.pdf.getPage(index + 1);
  const rotation = (page.rotate + tab.viewer.rotation) % 360;
  const layers = tab.viewer.ocVersion; // layer visibility changes the picture
  const key = page.ref ? `${page.ref.num}-${page.ref.gen}-${rotation}-${layers}` : `i${index}-${rotation}-${layers}`;
  tab.thumbKeys[index] = key;
  const cached = tab.thumbs.get(key);
  if (cached) {
    // Map order is our LRU order: move to the end.
    tab.thumbs.delete(key);
    tab.thumbs.set(key, cached);
    return cached;
  }

  const vp1 = page.getViewport({ scale: 1, rotation });
  const scale = (RENDER_WIDTH * Math.min(2, window.devicePixelRatio || 1)) / vp1.width;
  const viewport = page.getViewport({ scale, rotation });
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(viewport.width));
  canvas.height = Math.max(1, Math.round(viewport.height));
  const oc = (await tab.viewer.ocConfigPromise) ?? null;
  await page.render({ canvas, viewport, optionalContentConfigPromise: oc ? Promise.resolve(oc) : undefined }).promise;
  const blob = await canvasToBlob(canvas);
  canvas.width = 0;
  canvas.height = 0;
  if (!blob) return null;
  const url = URL.createObjectURL(blob);
  tab.thumbs.set(key, url);
  while (tab.thumbs.size > MAX_THUMBS) {
    const [oldKey, oldUrl] = tab.thumbs.entries().next().value;
    URL.revokeObjectURL(oldUrl);
    tab.thumbs.delete(oldKey);
  }
  return url;
}

/** The document changed: forget thumbnails whose content may differ. */
export function invalidateThumbs(tab, { affected, structural }) {
  if (!tab.thumbs) return;
  if (affected) {
    for (const i of affected) {
      const key = tab.thumbKeys[i];
      if (key) {
        URL.revokeObjectURL(tab.thumbs.get(key));
        tab.thumbs.delete(key);
      }
    }
  } else if (!structural) {
    for (const url of tab.thumbs.values()) URL.revokeObjectURL(url);
    tab.thumbs.clear();
  }
  // Indexes may have moved; keys (page objects) stay valid.
  tab.thumbKeys = [];
}
