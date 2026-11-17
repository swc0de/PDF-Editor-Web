// Saved signatures (IndexedDB store "signatures"): { id, png: Uint8Array, width, height, created }.
import { idb } from './idb.js';

export async function listSignatures() {
  try {
    const all = await idb.getAll('signatures');
    return all.sort((a, b) => b.created - a.created);
  } catch {
    return [];
  }
}

export async function saveSignature({ png, width, height }) {
  const record = { id: `sig-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, png, width, height, created: Date.now() };
  await idb.put('signatures', record);
  return record;
}

export async function removeSignature(id) {
  await idb.delete('signatures', id);
}
