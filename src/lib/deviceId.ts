import { newId } from './compat';

/**
 * A stable id for this installation, used only to break exact-timestamp ties
 * when merging a delta file from another unit (see `lib/delta.ts`). It is not
 * an identity or a credential, so `localStorage` — small, local, and outside
 * the project file entirely — is the right place for it; nothing about the
 * project's own "no localStorage for real data" rule applies to one string.
 */
const KEY = 'phototrack.deviceId';

let cached: string | null = null;

export function getDeviceId(): string {
  if (cached) return cached;
  try {
    let id = localStorage.getItem(KEY);
    if (!id) {
      id = newId();
      localStorage.setItem(KEY, id);
    }
    cached = id;
    return id;
  } catch {
    // Private browsing can throw on localStorage access. Fall back to a
    // per-session id — delta merges still work, just tie-break differently
    // within this one run.
    cached = newId();
    return cached;
  }
}
