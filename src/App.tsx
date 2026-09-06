import { useEffect, useRef } from 'react';
import { useTrackerStore } from '@/state/useTrackerStore';
import { redo, startHistory, undo } from '@/state/history';
import { Toolbar } from '@/components/toolbar/Toolbar';
import { StatsBar } from '@/components/toolbar/StatsBar';
import { ContactSheet } from '@/components/grid/ContactSheet';
import { BatchBar } from '@/components/grid/BatchBar';
import { Inspector } from '@/components/inspector/Inspector';
import { TrackerSheet } from '@/components/table/TrackerSheet';
import { clearRecovery, readRecovery, writeRecovery } from '@/lib/autosave';
import { debounce } from '@/lib/debounce';
import { parseProjectBytes, saveProject } from '@/lib/projectFiles';
import { desktop } from '@/lib/desktop';
import { PIPELINE_STAGES, type TrackerDocument } from '@/state/schema';

/**
 * The autosave debounce lives at module scope rather than in a ref: it only
 * ever needs one instance for the app's whole lifetime, and a plain module
 * value is simpler than the ref-that-holds-a-function dance for something
 * with no reactive inputs of its own.
 */
const saveRecoveryDebounced = debounce((doc: TrackerDocument) => void writeRecovery(doc), 800);

export default function App() {
  const view = useTrackerStore((s) => s.view);
  const activeRowId = useTrackerStore((s) => s.activeRowId);
  const revision = useTrackerStore((s) => s.revision);
  const togglePipeline = useTrackerStore((s) => s.togglePipeline);
  const addRow = useTrackerStore((s) => s.addRow);
  const newProject = useTrackerStore((s) => s.newProject);
  const setDoc = useTrackerStore((s) => s.setDoc);
  const markSaved = useTrackerStore((s) => s.markSaved);
  const bootedRef = useRef(false);

  // Undo/redo tracking starts once, for the app's lifetime.
  useEffect(() => startHistory(), []);

  // Crash recovery: offer to restore whatever the last session had in
  // flight before anything else renders meaningfully.
  useEffect(() => {
    if (bootedRef.current) return;
    bootedRef.current = true;
    void (async () => {
      const recovered = await readRecovery();
      if (!recovered) return;
      const bridge = desktop();
      const restore = bridge
        ? (await bridge.promptRecovery('a previous session')).restore
        : confirm('PhotoTrack found unsaved work from a previous session. Restore it?');
      if (restore) setDoc(recovered, null);
      else void clearRecovery();
    })();
  }, [setDoc]);

  // Debounced background save to the recovery slot on every change — the
  // fix for the old tool's unhandled `QuotaExceededError`: this never blocks
  // typing, and a failed write (see lib/autosave.ts) is swallowed rather
  // than silently corrupting the working session.
  useEffect(() => {
    saveRecoveryDebounced(useTrackerStore.getState().doc);
  }, [revision]);

  // Warn before closing with unsaved changes. The desktop shell has its own
  // native prompt, driven by telling it whether the doc is dirty.
  useEffect(() => {
    const bridge = desktop();
    if (bridge) {
      bridge.setDirty(useTrackerStore.getState().isDirty());
      return;
    }
    function onBeforeUnload(e: BeforeUnloadEvent) {
      if (!useTrackerStore.getState().isDirty()) return;
      e.preventDefault();
      e.returnValue = '';
    }
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [revision]);

  // Desktop menu wiring — a no-op in the browser build, since desktop() is
  // undefined there.
  useEffect(() => {
    const bridge = desktop();
    if (!bridge) return undefined;

    const offs = [
      bridge.onNew(() => newProject()),
      bridge.onSave(() =>
        void saveProject(useTrackerStore.getState().doc, false).then((p) => {
          if (p) markSaved(p);
        }),
      ),
      bridge.onSaveAs(() =>
        void saveProject(useTrackerStore.getState().doc, true).then((p) => {
          if (p) markSaved(p);
        }),
      ),
      bridge.onUndo(() => undo()),
      bridge.onRedo(() => redo()),
      bridge.onFileOpened((bytes, path) => {
        void parseProjectBytes(bytes).then((doc) => setDoc(doc, path));
      }),
    ];
    return () => offs.forEach((off) => off());
  }, [markSaved, newProject, setDoc]);

  // Keyboard shortcuts: Cmd/Ctrl+Z / Shift+Z for undo/redo, Cmd/Ctrl+S to
  // save, N to add a row, and 1–5 to toggle a pipeline stage on the row
  // currently open in the inspector — same hotkeys as the tool this
  // replaces, minus the bug where they fired while a select box had focus.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement;
      const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);

      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void saveProject(useTrackerStore.getState().doc, e.shiftKey).then((p) => {
          if (p) markSaved(p);
        });
        return;
      }
      if (typing) return;

      if (e.key.toLowerCase() === 'n') {
        e.preventDefault();
        addRow();
        return;
      }

      const idx = ['1', '2', '3', '4', '5'].indexOf(e.key);
      if (idx >= 0 && activeRowId) {
        e.preventDefault();
        const stage = PIPELINE_STAGES[idx];
        const row = useTrackerStore.getState().doc.rows[activeRowId];
        if (row) {
          if (row.usage === 'mag' || row.usage === 'both') togglePipeline(activeRowId, 'mag', stage);
          if (row.usage === 'pr' || row.usage === 'both') togglePipeline(activeRowId, 'pr', stage);
        }
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [activeRowId, addRow, markSaved, togglePipeline]);

  return (
    <div className="app-shell">
      <Toolbar />
      {view === 'grid' ? (
        <>
          <StatsBar />
          <BatchBar />
          <div className="app-main">
            <ContactSheet />
            {activeRowId && <Inspector />}
          </div>
        </>
      ) : (
        <TrackerSheet />
      )}
    </div>
  );
}
