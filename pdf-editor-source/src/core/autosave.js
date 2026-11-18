// Autosave of unsaved work to IndexedDB, and the records offered for
// recovery on the next launch.
import { idb } from './idb.js';

/**
 * @param {{ id: string, name: string, bytes: Uint8Array, handle?: any, steps?: string[] }} rec
 */
export async function writeAutosave({ id, name, bytes, handle = null, steps = [] }) {
  try {
    await idb.put('autosave', {
      id,
      name,
      bytes: new Blob([bytes], { type: 'application/pdf' }),
      size: bytes.length,
      handle,
      steps,
      savedAt: Date.now(),
    });
    return true;
  } catch {
    // Some browsers can't store file handles; retry without it.
    try {
      await idb.put('autosave', { id, name, bytes: new Blob([bytes], { type: 'application/pdf' }), size: bytes.length, handle: null, steps, savedAt: Date.now() });
      return true;
    } catch {
      return false;
    }
  }
}

export async function listAutosaves() {
  try {
    return (await idb.getAll('autosave')).sort((a, b) => b.savedAt - a.savedAt);
  } catch {
    return [];
  }
}

export async function deleteAutosave(id) {
  try {
    await idb.delete('autosave', id);
  } catch {
    /* ignore */
  }
}
