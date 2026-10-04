import { unpackDocument } from './projectFiles';
import { desktop } from './desktop';
import { migrate, type AssetMeta, type TrackerDocument } from '@/state/schema';

/**
 * Crash recovery.
 *
 * A background copy of the open project, written shortly after every edit,
 * so a crash or a force-quit loses at most the last second of work.
 *
 * The shot data and the photos are stored separately, and that's the point.
 * The shot data is small and changes constantly; photos are large and never
 * change once imported (they're addressed by content hash). So each autosave
 * writes the shot data in full and only the photos it hasn't stored yet —
 * the previous version re-encoded and re-zipped every image in the project
 * on every edit, which is what made the app stall as projects grew.
 *
 * Stored in IndexedDB in both builds: in the desktop app that lives in the
 * app's own profile folder on disk, with a disk-sized quota — nothing like
 * the few-megabyte localStorage limit the original tool died on.
 */

const DB_NAME = 'phototrack-recovery';
const DB_VERSION = 1;
const DOC_STORE = 'doc';
const ASSET_STORE = 'assets';
const DOC_KEY = 'current';

type AssetManifest = Record<string, Omit<AssetMeta, 'thumbUrl' | 'reviewUrl'>>;

interface StoredDoc {
  savedAt: number;
  doc: Omit<TrackerDocument, 'assets'> & { assets: AssetManifest };
}

let dbPromise: Promise<IDBDatabase> | null = null;
/** Asset hashes already in the store, so they're never written twice. */
let storedAssets: Set<string> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      if (!('indexedDB' in globalThis)) {
        reject(new Error('IndexedDB unavailable'));
        return;
      }
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(DOC_STORE)) db.createObjectStore(DOC_STORE);
        if (!db.objectStoreNames.contains(ASSET_STORE)) db.createObjectStore(ASSET_STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'));
    });
    dbPromise.catch(() => (dbPromise = null));
  }
  return dbPromise;
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

async function knownAssets(db: IDBDatabase): Promise<Set<string>> {
  if (!storedAssets) {
    const keys = await request(db.transaction(ASSET_STORE, 'readonly').objectStore(ASSET_STORE).getAllKeys());
    storedAssets = new Set(keys.map(String));
  }
  return storedAssets;
}

/** Best-effort — a failed autosave must never interrupt the session. */
export async function writeRecovery(doc: TrackerDocument): Promise<void> {
  try {
    const db = await openDb();
    const known = await knownAssets(db);

    const manifest: AssetManifest = {};
    const fresh: AssetMeta[] = [];
    for (const hash in doc.assets) {
      const { thumbUrl: _t, reviewUrl: _r, ...meta } = doc.assets[hash];
      manifest[hash] = meta;
      if (!known.has(hash)) fresh.push(doc.assets[hash]);
    }

    const tx = db.transaction([DOC_STORE, ASSET_STORE], 'readwrite');
    for (const asset of fresh) tx.objectStore(ASSET_STORE).put(asset, asset.hash);
    const stored: StoredDoc = { savedAt: Date.now(), doc: { ...doc, assets: manifest } };
    tx.objectStore(DOC_STORE).put(stored, DOC_KEY);
    await done(tx);
    for (const asset of fresh) known.add(asset.hash);
  } catch {
    // ignored — see above
  }
}

export async function readRecovery(): Promise<{ doc: TrackerDocument; savedAt: number } | null> {
  try {
    const db = await openDb();
    const stored = (await request(db.transaction(DOC_STORE, 'readonly').objectStore(DOC_STORE).get(DOC_KEY))) as
      | StoredDoc
      | undefined;
    if (stored?.doc) {
      const store = db.transaction(ASSET_STORE, 'readonly').objectStore(ASSET_STORE);
      const hashes = Object.keys(stored.doc.assets ?? {});
      const found = await Promise.all(hashes.map((hash) => request(store.get(hash)) as Promise<AssetMeta | undefined>));
      const assets: TrackerDocument['assets'] = {};
      for (const asset of found) if (asset) assets[asset.hash] = asset;
      const { doc } = migrate({ ...stored.doc, assets });
      return { doc: { ...doc, assets }, savedAt: stored.savedAt };
    }
  } catch {
    // fall through to the older on-disk copy
  }

  // Version 0.1 kept the desktop app's recovery copy as a zip on disk.
  const bridge = desktop();
  if (bridge) {
    try {
      const result = await bridge.readRecovery();
      if (result.ok && result.bytes) return { doc: unpackDocument(result.bytes), savedAt: 0 };
    } catch {
      // nothing recoverable
    }
  }
  return null;
}

export async function clearRecovery(): Promise<void> {
  try {
    const db = await openDb();
    const tx = db.transaction([DOC_STORE, ASSET_STORE], 'readwrite');
    tx.objectStore(DOC_STORE).clear();
    tx.objectStore(ASSET_STORE).clear();
    await done(tx);
    storedAssets = new Set();
  } catch {
    // ignored
  }
  try {
    await desktop()?.clearRecovery();
  } catch {
    // ignored
  }
}
