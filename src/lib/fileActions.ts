import { useTrackerStore } from '@/state/useTrackerStore';
import { buildDelta, mergeDelta } from './delta';
import { getLastDeltaExportAt, setLastDeltaExportAt } from './deltaCursor';
import { desktop } from './desktop';
import { clearRecovery } from './autosave';
import { openDelta, openProject, saveDelta, saveProject, suggestedFileName } from './projectFiles';
import { toast } from './toast';

/**
 * Every file command in one place, so the menu bar, the File menu in the
 * window, and keyboard shortcuts all do exactly the same thing.
 */

const store = () => useTrackerStore.getState();

function guardUnsaved(action: string): boolean {
  if (!store().isDirty()) return true;
  return confirm(`You have unsaved changes. Discard them and ${action}?`);
}

export function newProjectAction() {
  if (!guardUnsaved('start a new project')) return;
  store().newProject();
}

export async function openProjectAction() {
  if (!guardUnsaved('open a different project')) return;
  const result = await openProject();
  if (result) {
    store().setDoc(result.doc, result.path);
    toast(`Opened ${result.path ? result.path.split('/').pop() : 'project'}`, 'good');
  }
}

export async function saveAction(forceDialog = false) {
  const path = await saveProject(store().doc, forceDialog);
  if (!path) return;
  store().markSaved(path);
  void clearRecovery();
  toast(`Saved ${path.split('/').pop()}`, 'good');
}

function onSheet(run: () => void) {
  store().setView('sheet');
  // Let the sheet render before the print engine snapshots the page.
  requestAnimationFrame(() => requestAnimationFrame(run));
}

export function printAction() {
  onSheet(() => {
    const bridge = desktop();
    if (bridge) void bridge.print();
    else window.print();
  });
}

export function exportPdfAction() {
  onSheet(() => {
    const bridge = desktop();
    if (bridge) void bridge.exportPdf(suggestedFileName(store().doc, ''));
  });
}

export async function exportDeltaAction() {
  const doc = store().doc;
  const delta = buildDelta(doc, getLastDeltaExportAt());
  if (Object.keys(delta.rows).length === 0 && Object.keys(delta.deletedRowIds).length === 0) {
    toast('Nothing has changed since the last delta export.');
    return;
  }
  const path = await saveDelta(delta, doc);
  if (path) {
    setLastDeltaExportAt(delta.exportedAt);
    toast(`Exported ${Object.keys(delta.rows).length} changed shot(s)`, 'good');
  }
}

export async function importDeltaAction() {
  const delta = await openDelta();
  if (!delta) return;
  const { doc, summary } = mergeDelta(store().doc, delta);
  store().applyMergedDoc(doc);
  toast(
    `Merged: ${summary.rowsAdded} new, ${summary.rowsUpdated} updated, ${summary.rowsDeleted} deleted` +
      (summary.commentsChanged ? `, ${summary.commentsChanged} comment(s)` : ''),
    'good',
    6000,
  );
}
