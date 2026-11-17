// Recent files, kept in IndexedDB in this browser only. Metadata and a small
// first-page thumbnail live in "recents"; the file bytes live separately in
// "recentFiles" so listing recents never loads whole PDFs.
import { idb } from './idb.js';

export const MAX_RECENTS = 12;
/** Files larger than this are listed but not stored (re-open from disk). */
export const MAX_STORED_BYTES = 150 * 1024 * 1024;

const listeners = new Set();
export function onRecentsChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
const emit = () => listeners.forEach((fn) => fn());

/** A stable id for a file's content (SHA-256, or a sampled hash fallback). */
export async function contentId(bytes) {
  try {
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(digest).slice(0, 16)].map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    // FNV-1a over up to 64k sampled bytes + the length.
    let h = 0x811c9dc5;
    const step = Math.max(1, Math.floor(bytes.length / 65536));
    for (let i = 0; i < bytes.length; i += step) {
      h ^= bytes[i];
      h = Math.imul(h, 0x01000193);
    }
    return `f${(h >>> 0).toString(16)}-${bytes.length.toString(16)}`;
  }
}

export async function listRecents() {
  try {
    const all = await idb.getAll('recents');
    return all.sort((a, b) => b.lastOpened - a.lastOpened);
  } catch {
    return [];
  }
}

/**
 * Remember a file. `thumbnail` is an optional image Blob.
 * Returns false if storage isn't available.
 */
export async function addRecent({ id, name, bytes, pageCount, thumbnail = null, handle = null }) {
  try {
    const stored = bytes.length <= MAX_STORED_BYTES;
    const existing = await idb.get('recents', id);
    const record = {
      id,
      name,
      size: bytes.length,
      pageCount,
      lastOpened: Date.now(),
      stored,
      thumbnail: thumbnail ?? existing?.thumbnail ?? null,
      // A FileSystemFileHandle lets "Save" write back after reopening.
      handle: handle ?? existing?.handle ?? null,
    };
    try {
      await idb.put('recents', record);
    } catch {
      await idb.put('recents', { ...record, handle: null }); // handle not storable here
    }
    if (stored) await idb.put('recentFiles', { id, bytes: new Blob([bytes], { type: 'application/pdf' }) });
    await prune();
    emit();
    return true;
  } catch {
    return false;
  }
}

export async function setRecentThumbnail(id, thumbnail) {
  try {
    const rec = await idb.get('recents', id);
    if (!rec) return;
    rec.thumbnail = thumbnail;
    await idb.put('recents', rec);
    emit();
  } catch {
    /* ignore */
  }
}

/** The stored bytes of a recent file, or null. */
export async function getRecentBytes(id) {
  try {
    const rec = await idb.get('recentFiles', id);
    if (!rec) return null;
    return new Uint8Array(await rec.bytes.arrayBuffer());
  } catch {
    return null;
  }
}

export async function removeRecent(id) {
  try {
    await idb.delete('recents', id);
    await idb.delete('recentFiles', id);
  } finally {
    emit();
  }
}

export async function clearRecents() {
  try {
    await idb.clear('recents');
    await idb.clear('recentFiles');
  } finally {
    emit();
  }
}

async function prune() {
  const all = await listRecents();
  for (const old of all.slice(MAX_RECENTS)) {
    await idb.delete('recents', old.id);
    await idb.delete('recentFiles', old.id);
  }
}
