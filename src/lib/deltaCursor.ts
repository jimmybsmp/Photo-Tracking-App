/**
 * When this installation last exported a delta, so "export what's changed"
 * has a starting point without asking. Per-device, not per-project — this
 * app is built around one unit working one production at a time, so that is
 * an acceptable simplification; a "since the beginning" export is always
 * available by clearing it.
 */
const KEY = 'phototrack.lastDeltaExportAt';

export function getLastDeltaExportAt(): number {
  try {
    return Number(localStorage.getItem(KEY) ?? 0) || 0;
  } catch {
    return 0;
  }
}

export function setLastDeltaExportAt(t: number): void {
  try {
    localStorage.setItem(KEY, String(t));
  } catch {
    // ignore — worst case, the next export just includes a bit more
  }
}
