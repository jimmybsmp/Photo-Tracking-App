import { useState } from 'react';
import { useTrackerStore } from '@/state/useTrackerStore';
import { useShallow } from 'zustand/react/shallow';
import { redo, undo } from '@/state/history';
import { useHistoryFlags } from '@/state/useHistoryFlags';
import { openProject, saveProject, openDelta, saveDelta, suggestedFileName } from '@/lib/projectFiles';
import { buildDelta, mergeDelta } from '@/lib/delta';
import { getLastDeltaExportAt, setLastDeltaExportAt } from '@/lib/deltaCursor';
import { documentBytes } from '@/state/schema';
import { desktop, isDesktop } from '@/lib/desktop';
import { clearRecovery } from '@/lib/autosave';
import { Button, FilterChip, TextInput } from '@/components/ui/controls';
import { ElvisPanel } from '@/components/elvis/ElvisPanel';
import type { SelectFilter, ShotTypeFilter, UsageFilter } from '@/state/useTrackerStore';

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function Toolbar() {
  const view = useTrackerStore((s) => s.view);
  const setView = useTrackerStore((s) => s.setView);
  const filters = useTrackerStore(useShallow((s) => s.filters));
  const setFilters = useTrackerStore((s) => s.setFilters);
  const header = useTrackerStore(useShallow((s) => s.doc.header));
  const setHeader = useTrackerStore((s) => s.setHeader);
  const currentPath = useTrackerStore((s) => s.currentPath);
  const setDoc = useTrackerStore((s) => s.setDoc);
  const newProject = useTrackerStore((s) => s.newProject);
  const markSaved = useTrackerStore((s) => s.markSaved);
  const applyMergedDoc = useTrackerStore((s) => s.applyMergedDoc);
  const gridZoom = useTrackerStore((s) => s.gridZoom);
  const setGridZoom = useTrackerStore((s) => s.setGridZoom);
  const { undo: canUndoNow, redo: canRedoNow } = useHistoryFlags();
  const [elvisOpen, setElvisOpen] = useState(false);

  const bytes = useTrackerStore((s) => documentBytes(s.doc));
  const isDirty = useTrackerStore((s) => s.revision !== s.savedRevision);

  async function guardUnsaved(message: string): Promise<boolean> {
    if (!useTrackerStore.getState().isDirty()) return true;
    return confirm(message);
  }

  async function handleNew() {
    if (!(await guardUnsaved('Discard unsaved changes and start a new project?'))) return;
    newProject();
  }

  async function handleOpen() {
    if (!(await guardUnsaved('Discard unsaved changes and open a different project?'))) return;
    const result = await openProject();
    if (result) setDoc(result.doc, result.path);
  }

  async function handleSave(forceDialog: boolean) {
    const path = await saveProject(useTrackerStore.getState().doc, forceDialog);
    if (path) {
      markSaved(path);
      void clearRecovery();
    }
  }

  function handlePrint() {
    setView('sheet');
    requestAnimationFrame(() => {
      const bridge = desktop();
      if (bridge) void bridge.print();
      else window.print();
    });
  }

  function handleExportPdf() {
    setView('sheet');
    requestAnimationFrame(() => {
      const bridge = desktop();
      if (bridge) void bridge.exportPdf(suggestedFileName(useTrackerStore.getState().doc, ''));
    });
  }

  async function handleExportDelta() {
    const doc = useTrackerStore.getState().doc;
    const since = getLastDeltaExportAt();
    const delta = buildDelta(doc, since);
    const rowCount = Object.keys(delta.rows).length;
    const deleteCount = Object.keys(delta.deletedRowIds).length;
    if (rowCount === 0 && deleteCount === 0) {
      alert('Nothing has changed since the last delta export.');
      return;
    }
    const path = await saveDelta(delta, doc);
    if (path) setLastDeltaExportAt(delta.exportedAt);
  }

  async function handleImportDelta() {
    const delta = await openDelta();
    if (!delta) return;
    const { doc, summary } = mergeDelta(useTrackerStore.getState().doc, delta);
    applyMergedDoc(doc);
    alert(
      `Merged: ${summary.rowsAdded} new, ${summary.rowsUpdated} updated (${summary.fieldsChanged} fields), ` +
        `${summary.rowsDeleted} deleted${summary.headerChanged ? ', header updated' : ''}.`,
    );
  }

  return (
    <div className="toolbar no-print">
      <div className="toolbar-row">
        <div className="toolbar-group">
          <Button onClick={handleNew}>New</Button>
          <Button onClick={handleOpen}>Open…</Button>
          <Button variant="primary" onClick={() => void handleSave(false)}>
            Save{isDirty ? ' •' : ''}
          </Button>
          <Button onClick={() => void handleSave(true)}>Save As…</Button>
          <Button onClick={handlePrint}>Print</Button>
          {isDesktop() && <Button onClick={handleExportPdf}>Export PDF…</Button>}
        </div>

        <div className="toolbar-group">
          <Button onClick={undo} disabled={!canUndoNow} title="Undo">
            ↶ Undo
          </Button>
          <Button onClick={redo} disabled={!canRedoNow} title="Redo">
            ↷ Redo
          </Button>
        </div>

        <div className="toolbar-group">
          <FilterChip active={view === 'grid'} onClick={() => setView('grid')}>
            Grid
          </FilterChip>
          <FilterChip active={view === 'sheet'} onClick={() => setView('sheet')}>
            Sheet
          </FilterChip>
          {view === 'grid' && (
            <input
              type="range"
              min={0.5}
              max={2}
              step={0.1}
              value={gridZoom}
              onChange={(e) => setGridZoom(Number(e.target.value))}
              title="Tile size"
              className="zoom-slider"
            />
          )}
        </div>

        <div className="toolbar-group toolbar-group-header">
          <TextInput
            value={header.event}
            placeholder="Event / Client…"
            onChange={(e) => setHeader({ event: e.target.value })}
          />
          <TextInput value={header.date} placeholder="Date…" onChange={(e) => setHeader({ date: e.target.value })} />
        </div>
      </div>

      <div className="toolbar-row">
        <div className="toolbar-group">
          <span className="toolbar-label">Usage:</span>
          {(['all', 'mag', 'pr', 'both'] as UsageFilter[]).map((v) => (
            <FilterChip key={v} active={filters.usage === v} onClick={() => setFilters({ usage: v })}>
              {v === 'all' ? 'All' : v === 'mag' ? 'Mag' : v === 'pr' ? 'PR' : 'Both'}
            </FilterChip>
          ))}
        </div>

        <div className="toolbar-group">
          <span className="toolbar-label">Shot type:</span>
          {(['all', 'longshot', 'closeup'] as ShotTypeFilter[]).map((v) => (
            <FilterChip key={v} active={filters.shotType === v} onClick={() => setFilters({ shotType: v })}>
              {v === 'all' ? 'All' : v === 'longshot' ? 'Longshot' : 'Close-up'}
            </FilterChip>
          ))}
        </div>

        <div className="toolbar-group">
          <span className="toolbar-label">Select:</span>
          {(['all', 'main', 'alt'] as SelectFilter[]).map((v) => (
            <FilterChip key={v} active={filters.select === v} onClick={() => setFilters({ select: v })}>
              {v === 'all' ? 'All' : v === 'main' ? 'Main' : 'Alt'}
            </FilterChip>
          ))}
        </div>

        <TextInput
          value={filters.search}
          placeholder="Search shot #, retoucher, notes…"
          onChange={(e) => setFilters({ search: e.target.value })}
          className="toolbar-search"
        />

        <div className="toolbar-group toolbar-group-right">
          <Button onClick={() => void handleExportDelta()} title="Export everything changed since the last export, to share with another unit">
            Export Delta…
          </Button>
          <Button onClick={() => void handleImportDelta()} title="Merge in a delta file from another unit">
            Import Delta…
          </Button>
          <Button onClick={() => setElvisOpen(true)} title="WoodWing Elvis DAM sync (desktop app only)">
            Elvis Sync…
          </Button>
          <span className="toolbar-hint">
            {formatBytes(bytes)}
            {currentPath ? ` · ${currentPath.split('/').pop()}` : ''}
          </span>
        </div>
      </div>

      {elvisOpen && <ElvisPanel onClose={() => setElvisOpen(false)} />}
    </div>
  );
}

