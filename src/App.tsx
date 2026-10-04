import { useEffect, useRef, useState } from 'react';
import { useTrackerStore } from '@/state/useTrackerStore';
import { redo, startHistory, undo } from '@/state/history';
import { applicableStages } from '@/state/selectors';
import { clearRecovery, readRecovery, writeRecovery } from '@/lib/autosave';
import { debounce } from '@/lib/debounce';
import { desktop } from '@/lib/desktop';
import { getIdentity } from '@/lib/identity';
import { startAutoSync } from '@/lib/elvis/autoSync';
import { parseProjectBytes } from '@/lib/projectFiles';
import { newProjectAction, openProjectAction, printAction, saveAction } from '@/lib/fileActions';
import { toast } from '@/lib/toast';
import type { TrackerDocument } from '@/state/schema';
import { TopBar } from '@/components/shell/TopBar';
import { IdentityDialog } from '@/components/shell/IdentityDialog';
import { Toasts } from '@/components/shell/Toasts';
import { Overview } from '@/components/overview/Overview';
import { ContactSheet } from '@/components/grid/ContactSheet';
import { useFileImport } from '@/components/grid/useFileImport';
import { Inspector } from '@/components/inspector/Inspector';
import { TrackerSheet } from '@/components/table/TrackerSheet';
import { ElvisPanel } from '@/components/elvis/ElvisPanel';

/** One autosave scheduler for the app's lifetime. */
const autosave = debounce((doc: TrackerDocument) => void writeRecovery(doc), 800);

export default function App() {
  const view = useTrackerStore((s) => s.view);
  const activeRowId = useTrackerStore((s) => s.activeRowId);
  const revision = useTrackerStore((s) => s.revision);
  const [elvisOpen, setElvisOpen] = useState(false);
  const [identityOpen, setIdentityOpen] = useState(() => !getIdentity());
  const { importFiles } = useFileImport();
  const importRef = useRef<HTMLInputElement>(null);
  const modalOpen = elvisOpen || identityOpen;

  useEffect(() => startHistory(), []);
  useEffect(() => startAutoSync(), []);

  // Crash recovery, once at startup. A restored copy stays marked unsaved:
  // it exists only in the recovery store until someone saves it.
  const booted = useRef(false);
  useEffect(() => {
    if (booted.current) return;
    booted.current = true;
    void (async () => {
      const recovered = await readRecovery();
      if (!recovered || recovered.doc.rowIds.length === 0) return;
      const bridge = desktop();
      const restore = bridge
        ? (await bridge.promptRecovery('your last session')).restore
        : confirm('PhotoTrack found unsaved work from your last session. Restore it?');
      if (restore) {
        useTrackerStore.getState().setDoc(recovered.doc, null, { dirty: true });
        toast('Restored your unsaved work — save it to keep it.', 'good', 6000);
      } else {
        void clearRecovery();
      }
    })();
  }, []);

  useEffect(() => {
    if (revision > 0) autosave(useTrackerStore.getState().doc);
  }, [revision]);

  // Unsaved-changes warning on close. The desktop app shows a native one.
  useEffect(() => {
    const bridge = desktop();
    if (bridge) {
      bridge.setDirty(useTrackerStore.getState().isDirty());
      return undefined;
    }
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (!useTrackerStore.getState().isDirty()) return;
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [revision]);

  // A photo dropped where nothing accepts it must never navigate the window
  // to the image — that would throw away everything unsaved.
  useEffect(() => {
    const stop = (e: DragEvent) => e.preventDefault();
    window.addEventListener('dragover', stop);
    window.addEventListener('drop', stop);
    return () => {
      window.removeEventListener('dragover', stop);
      window.removeEventListener('drop', stop);
    };
  }, []);

  // The desktop menu bar.
  useEffect(() => {
    const bridge = desktop();
    if (!bridge) return undefined;
    const offs = [
      bridge.onNew(() => newProjectAction()),
      bridge.onSave(() => void saveAction(false)),
      bridge.onSaveAs(() => void saveAction(true)),
      bridge.onPrint(() => printAction()),
      bridge.onUndo(() => undo()),
      bridge.onRedo(() => redo()),
      bridge.onFileOpened((bytes, path) => {
        void parseProjectBytes(bytes)
          .then((doc) => useTrackerStore.getState().setDoc(doc, path))
          .catch(() => toast('That file could not be opened.', 'bad'));
      }),
    ];
    return () => offs.forEach((off) => off());
  }, []);

  // Keyboard. Stage hotkeys act on the shot open in the inspector: 1–5 for
  // its magazine track (or its only track), ⇧1–5 for press release when it
  // runs in both. Nothing fires while typing in a field or with a dialog up.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      const key = e.key.toLowerCase();
      const target = e.target as HTMLElement;
      const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.isContentEditable;

      if (mod && key === 'z' && !typing) {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
        return;
      }
      if (mod && key === 's') {
        e.preventDefault();
        void saveAction(e.shiftKey);
        return;
      }
      if (mod && key === 'o' && !desktop()) {
        e.preventDefault();
        void openProjectAction();
        return;
      }
      if (typing || modalOpen || mod) return;

      const store = useTrackerStore.getState();
      if (e.key === 'Escape') {
        if (store.activeRowId) store.openRow(null);
        else store.clearSelection();
        return;
      }
      if (key === 'n' && store.view !== 'overview') {
        e.preventDefault();
        store.openRow(store.addRow());
        return;
      }
      const digit = /^Digit([1-5])$/.exec(e.code);
      if (digit && store.activeRowId) {
        const row = store.doc.rows[store.activeRowId];
        if (!row || row.usage === 'none') return;
        const stage = applicableStages(row)[Number(digit[1]) - 1];
        if (!stage) return;
        e.preventDefault();
        const side = row.usage === 'pr' || (row.usage === 'both' && e.shiftKey) ? 'pr' : 'mag';
        store.toggleStage(row.id, side, stage);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [modalOpen]);

  return (
    <div className="app">
      <TopBar onOpenElvis={() => setElvisOpen(true)} onEditIdentity={() => setIdentityOpen(true)} />
      <main className="app-main">
        <div className="app-view">
          {view === 'overview' && <Overview onImport={() => importRef.current?.click()} />}
          {view === 'shots' && <ContactSheet />}
          {view === 'sheet' && <TrackerSheet />}
        </div>
        {activeRowId && view !== 'overview' && <Inspector />}
      </main>

      <input
        ref={importRef}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(e) => {
          if (e.target.files) {
            void importFiles(e.target.files);
            useTrackerStore.getState().setView('shots');
          }
          e.target.value = '';
        }}
      />

      {elvisOpen && <ElvisPanel onClose={() => setElvisOpen(false)} />}
      {identityOpen && <IdentityDialog required={!getIdentity()} onDone={() => setIdentityOpen(false)} />}
      <Toasts />
    </div>
  );
}
