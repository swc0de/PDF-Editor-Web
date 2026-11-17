// Minimal IndexedDB helper. Every call fails soft: if storage is blocked
// (private windows, disabled site data) the app keeps working without it.

const DB_NAME = 'pdf-editor';
const DB_VERSION = 2;

// Object stores: recents (metadata + thumbnail), recentFiles (bytes),
// autosave (M4), signatures (M9), prefs (v2). Upgrades only add stores.
const STORES = {
  recents: { keyPath: 'id' },
  recentFiles: { keyPath: 'id' },
  autosave: { keyPath: 'id' },
  signatures: { keyPath: 'id' },
  prefs: { keyPath: 'key' }, // mirror of localStorage preferences (v2)
};

let dbPromise = null;

export function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      let req;
      try {
        req = indexedDB.open(DB_NAME, DB_VERSION);
      } catch (err) {
        reject(err);
        return;
      }
      req.onupgradeneeded = () => {
        const db = req.result;
        for (const [name, opts] of Object.entries(STORES)) {
          if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, opts);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error('IndexedDB upgrade blocked'));
    }).catch((err) => {
      dbPromise = null;
      throw err;
    });
  }
  return dbPromise;
}

function promisify(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function withStore(name, mode, fn) {
  const db = await openDb();
  const tx = db.transaction(name, mode);
  const result = await fn(tx.objectStore(name));
  await new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('transaction aborted'));
  });
  return result;
}

/** Empty every store (used by tests and for "forget everything"). */
export async function clearAllStores() {
  for (const name of Object.keys(STORES)) {
    try {
      await withStore(name, 'readwrite', (s) => promisify(s.clear()));
    } catch {
      /* ignore */
    }
  }
}

export const idb = {
  get: (store, key) => withStore(store, 'readonly', (s) => promisify(s.get(key))),
  getAll: (store) => withStore(store, 'readonly', (s) => promisify(s.getAll())),
  put: (store, value) => withStore(store, 'readwrite', (s) => promisify(s.put(value))),
  delete: (store, key) => withStore(store, 'readwrite', (s) => promisify(s.delete(key))),
  clear: (store) => withStore(store, 'readwrite', (s) => promisify(s.clear())),
};
