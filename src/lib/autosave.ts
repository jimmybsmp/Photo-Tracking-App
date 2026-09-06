import { packDocument, unpackDocument } from './projectFiles';
import { desktop } from './desktop';
import type { TrackerDocument } from '@/state/schema';

/**
 * Crash recovery.
 *
 * The old tool's only save was `localStorage.setItem` on every keystroke,
 * with no error handling — once a project's embedded images pushed it past
 * the ~5MB quota, every save silently failed and the next reload lost
 * everything back to the last save that fit. This replaces that with a
 * debounced background save of the packed project (see App.tsx for the
 * debounce), written to disk in the desktop app (survives a crash or a
 * force-quit) and to IndexedDB in the browser build (whose quota is disk-
 * sized, not the few megabytes `localStorage` gets).
 */

const DB_NAME = 'phototrack-autosave';
const STORE = 'draft';
const KEY = 'current';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in globalThis)) {
      reject(new Error('IndexedDB unavailable'));
      return;
    }
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'));
  });
}

async function idbSet(bytes: Uint8Array): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(bytes, KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB write failed'));
  });
  db.close();
}

async function idbGet(): Promise<Uint8Array | null> {
  const db = await openDb();
  const result = await new Promise<Uint8Array | null>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(KEY);
    req.onsuccess = () => resolve((req.result as Uint8Array | undefined) ?? null);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB read failed'));
  });
  db.close();
  return result;
}

async function idbClear(): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB clear failed'));
  });
  db.close();
}

/** Best-effort — a failed autosave should never interrupt the session. */
export async function writeRecovery(doc: TrackerDocument): Promise<void> {
  try {
    const bytes = packDocument(doc);
    const bridge = desktop();
    if (bridge) await bridge.writeRecovery(bytes);
    else await idbSet(bytes);
  } catch {
    // ignored — see above
  }
}

export async function readRecovery(): Promise<TrackerDocument | null> {
  try {
    const bridge = desktop();
    if (bridge) {
      const result = await bridge.readRecovery();
      if (!result.ok || !result.bytes) return null;
      return unpackDocument(result.bytes);
    }
    const bytes = await idbGet();
    return bytes ? unpackDocument(bytes) : null;
  } catch {
    return null;
  }
}

export async function clearRecovery(): Promise<void> {
  try {
    const bridge = desktop();
    if (bridge) await bridge.clearRecovery();
    else await idbClear();
  } catch {
    // ignored
  }
}
