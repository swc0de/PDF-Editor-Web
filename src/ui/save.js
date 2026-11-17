// Saving: write back to the original file through the File System Access API
// when we have a handle for it, otherwise download. Save As suggests the
// "-edited" name.
import { t } from '../i18n/index.js';
import { toast } from './toast.js';

const PDF_TYPES = [{ description: 'PDF', accept: { 'application/pdf': ['.pdf'] } }];

/** "report.pdf" → "report-edited.pdf" (idempotent). */
export function editedName(name) {
  const base = name.replace(/\.pdf$/i, '');
  return `${base.endsWith('-edited') ? base : `${base}-edited`}.pdf`;
}

async function ensureWritable(handle) {
  const opts = { mode: 'readwrite' };
  if (handle.queryPermission && (await handle.queryPermission(opts)) === 'granted') return true;
  if (handle.requestPermission && (await handle.requestPermission(opts)) === 'granted') return true;
  return !handle.queryPermission; // no permission API: just try
}

async function writeToHandle(handle, bytes) {
  if (!(await ensureWritable(handle))) {
    const err = new Error('Permission to write the file was denied');
    err.name = 'NotAllowedError';
    throw err;
  }
  const writable = await handle.createWritable();
  await writable.write(new Blob([bytes], { type: 'application/pdf' }));
  await writable.close();
}

export function downloadBytes(bytes, name, type = 'application/pdf') {
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/**
 * Save a tab. Returns true when the document was written somewhere.
 * @param {import('./doc-tab.js').DocTab} tab
 * @param {{ as?: boolean }} [o]
 */
export async function saveTab(tab, { as = false } = {}) {
  const model = tab.model;
  // Wait for edits in flight so we save what the user sees.
  await model.queue;
  const bytes = model.bytes;

  if (!as && model.fileHandle) {
    try {
      await writeToHandle(model.fileHandle, bytes);
      model.markSaved();
      toast(t('save.saved', { name: tab.name }));
      return true;
    } catch (err) {
      if (err.name === 'AbortError') return false;
      toast(t('save.writeFailed', { message: err.message }), { kind: 'error', timeout: 6000 });
      return saveTab(tab, { as: true });
    }
  }

  if (!as) {
    downloadBytes(bytes, tab.name);
    model.markSaved();
    toast(t('save.downloaded', { name: tab.name }));
    return true;
  }

  const suggestedName = editedName(tab.name);
  if (typeof window.showSaveFilePicker === 'function') {
    let handle;
    try {
      handle = await window.showSaveFilePicker({ suggestedName, types: PDF_TYPES });
    } catch (err) {
      if (err.name === 'AbortError') return false;
      handle = null; // picker unavailable here: fall back to a download
    }
    if (handle) {
      await writeToHandle(handle, bytes);
      model.fileHandle = handle;
      tab.rename(handle.name ?? suggestedName);
      model.markSaved();
      toast(t('save.saved', { name: tab.name }));
      return true;
    }
  }
  downloadBytes(bytes, suggestedName);
  tab.rename(suggestedName);
  model.fileHandle = null;
  model.markSaved();
  toast(t('save.downloaded', { name: suggestedName }));
  return true;
}
