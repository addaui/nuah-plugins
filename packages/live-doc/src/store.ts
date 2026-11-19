// SPDX-License-Identifier: Apache-2.0
/** Where a browser keeps its Live documents between visits: the document and the server's version it last knew (so unsent changes are known). */
export interface Saved {
  snapshot: Uint8Array;
  server: Uint8Array | null;
}

export interface LiveStore {
  load(key: string): Promise<Saved | null>;
  save(key: string, value: Saved): Promise<void>;
  remove(key: string): Promise<void>;
}

/** For tests, and when the browser offers no storage. */
export function memoryStore(): LiveStore {
  const m = new Map<string, Saved>();
  return {
    load: async (k) => m.get(k) ?? null,
    save: async (k, v) => { m.set(k, v); },
    remove: async (k) => { m.delete(k); },
  };
}

/** IndexedDB, one object store of documents by key. Falls back to memory when IndexedDB cannot be opened (a private window may refuse it). */
export function idbStore(name = "nuah-live", factory: IDBFactory | undefined = globalThis.indexedDB): LiveStore {
  const fallback = memoryStore();
  let opening: Promise<IDBDatabase | null> | null = null;
  const db = () => (opening ??= new Promise<IDBDatabase | null>((resolve) => {
    if (!factory) return resolve(null);
    try {
      const r = factory.open(name, 1);
      r.onupgradeneeded = () => { r.result.createObjectStore("docs"); };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => resolve(null);
      r.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  }));
  const run = <T>(mode: IDBTransactionMode, f: (s: IDBObjectStore) => IDBRequest): Promise<T> =>
    db().then((d) => new Promise<T>((resolve, reject) => {
      if (!d) return reject(new Error("no IndexedDB"));
      const req = f(d.transaction("docs", mode).objectStore("docs"));
      req.onsuccess = () => resolve(req.result as T);
      req.onerror = () => reject(req.error);
    }));
  return {
    load: (k) => run<Saved | undefined>("readonly", (s) => s.get(k)).then((v) => v ?? null, () => fallback.load(k)),
    save: (k, v) => run<unknown>("readwrite", (s) => s.put(v, k)).then(() => undefined, () => fallback.save(k, v)),
    remove: (k) => run<unknown>("readwrite", (s) => s.delete(k)).then(() => undefined, () => fallback.remove(k)),
  };
}
