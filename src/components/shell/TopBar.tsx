import { useEffect, useRef, useState } from 'react';
import { useTrackerStore, type ViewMode } from '@/state/useTrackerStore';
import { redo, undo } from '@/state/history';
import { useHistoryFlags } from '@/state/useHistoryFlags';
import { isDesktop } from '@/lib/desktop';
import {
  exportDeltaAction,
  exportPdfAction,
  importDeltaAction,
  newProjectAction,
  openProjectAction,
  printAction,
  saveAction,
} from '@/lib/fileActions';
import { useIdentity } from '@/components/ui/hooks';
import { SyncChip } from './SyncChip';

const VIEWS: Array<{ id: ViewMode; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'shots', label: 'Shots' },
  { id: 'sheet', label: 'Sheet' },
];

export function TopBar({ onOpenElvis, onEditIdentity }: { onOpenElvis: () => void; onEditIdentity: () => void }) {
  const view = useTrackerStore((s) => s.view);
  const setView = useTrackerStore((s) => s.setView);
  const event = useTrackerStore((s) => s.doc.header.event);
  const dirty = useTrackerStore((s) => s.revision !== s.savedRevision);
  const path = useTrackerStore((s) => s.currentPath);
  const { undo: canUndo, redo: canRedo } = useHistoryFlags();
  const identity = useIdentity();

  return (
    <header className="topbar no-print">
      <div className="topbar-left">
        <FileMenu />
        <div className="topbar-title">
          <span className="topbar-event">{event || 'Untitled shoot'}</span>
          <span className="topbar-file">
            {path ? path.split('/').pop() : 'Not saved yet'}
            {dirty && <span className="topbar-dirty"> · unsaved</span>}
          </span>
        </div>
      </div>

      <nav className="tabs" role="tablist">
        {VIEWS.map((v) => (
          <button
            key={v.id}
            role="tab"
            aria-selected={view === v.id}
            className={`tab ${view === v.id ? 'tab-active' : ''}`}
            onClick={() => setView(v.id)}
          >
            {v.label}
          </button>
        ))}
      </nav>

      <div className="topbar-right">
        <button className="icon-btn" onClick={undo} disabled={!canUndo} title="Undo (⌘Z)">
          ↶
        </button>
        <button className="icon-btn" onClick={redo} disabled={!canRedo} title="Redo (⇧⌘Z)">
          ↷
        </button>
        <SyncChip onClick={onOpenElvis} />
        <button className="user-chip" onClick={onEditIdentity} title="Change your name or role">
          <span className="user-avatar">{(identity?.name || '?').slice(0, 1).toUpperCase()}</span>
          <span className="user-name">{identity?.name || 'Set your name'}</span>
          {identity?.role === 'executive' && <span className="role-badge">Exec</span>}
        </button>
      </div>
    </header>
  );
}

function FileMenu() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return undefined;
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);

  const item = (label: string, run: () => unknown, hint?: string) => (
    <button
      className="menu-item"
      onClick={() => {
        setOpen(false);
        void run();
      }}
    >
      <span>{label}</span>
      {hint && <span className="menu-hint">{hint}</span>}
    </button>
  );

  return (
    <div className="menu" ref={ref}>
      <button className="btn" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        File ▾
      </button>
      {open && (
        <div className="menu-panel">
          {item('New project', newProjectAction)}
          {item('Open…', openProjectAction, '⌘O')}
          {item('Save', () => saveAction(false), '⌘S')}
          {item('Save as…', () => saveAction(true), '⇧⌘S')}
          <div className="menu-sep" />
          {item('Export changes for another unit…', exportDeltaAction)}
          {item('Import changes from another unit…', importDeltaAction)}
          <div className="menu-sep" />
          {item('Print sheet…', printAction, '⌘P')}
          {isDesktop() && item('Export sheet as PDF…', exportPdfAction)}
        </div>
      )}
    </div>
  );
}
