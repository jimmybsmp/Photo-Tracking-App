import { useTrackerStore } from './useTrackerStore';
import type { TrackerDocument } from './schema';

/**
 * Undo/redo for the tracker document.
 *
 * Rather than threading a history call through every mutating action, this
 * watches the store: every action already bumps `revision` when it changes
 * the document, so the previous document can be captured from the
 * subscription's `prevState`. A new action gets undo support for free.
 *
 * Snapshots are cheap despite holding image data — every mutation builds its
 * result by spreading, so a row (or the whole `assets` map) that did not
 * change is the same object in both snapshots, and the stack shares nearly
 * all of its structure.
 */

const LIMIT = 60;

let past: TrackerDocument[] = [];
let future: TrackerDocument[] = [];
/** Set while an undo or redo is applying, so it is not recorded as a new edit. */
let travelling = false;

type Listener = () => void;
const listeners = new Set<Listener>();
const notify = () => listeners.forEach((l) => l());

export function onHistoryChange(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export const canUndo = () => past.length > 0;
export const canRedo = () => future.length > 0;

export function startHistory(): () => void {
  return useTrackerStore.subscribe((state, prev) => {
    if (travelling) return;
    if (state.revision === prev.revision) return;
    if (state.doc === prev.doc) return;

    past.push(prev.doc);
    if (past.length > LIMIT) past.shift();
    if (future.length > 0) future = [];
    notify();
  });
}

function apply(doc: TrackerDocument) {
  travelling = true;
  try {
    useTrackerStore.setState((s) => ({
      doc,
      revision: s.revision + 1,
      selectedRowIds: s.selectedRowIds.filter((id) => Boolean(doc.rows[id])),
      activeRowId: s.activeRowId && doc.rows[s.activeRowId] ? s.activeRowId : null,
    }));
  } finally {
    travelling = false;
  }
  notify();
}

export function undo(): void {
  const previous = past.pop();
  if (!previous) return;
  future.push(useTrackerStore.getState().doc);
  apply(previous);
}

export function redo(): void {
  const next = future.pop();
  if (!next) return;
  past.push(useTrackerStore.getState().doc);
  apply(next);
}

/** Drop the stack — after opening a file or starting a new project. */
export function resetHistory(): void {
  past = [];
  future = [];
  notify();
}
