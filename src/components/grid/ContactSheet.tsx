import { useCallback, useMemo, useRef, useState } from 'react';
import { useTrackerStore } from '@/state/useTrackerStore';
import { useShallow } from 'zustand/react/shallow';
import { matchesFilters } from '@/state/selectors';
import { FilterBar } from '@/components/shell/FilterBar';
import { PhotoTile } from './PhotoTile';
import { BatchBar } from './BatchBar';
import { useFileImport } from './useFileImport';

/**
 * The Shots view: every shot as a tile, each showing where its magazine and
 * press-release tracks stand. Drop photos anywhere to add shots — every drop
 * handler calls preventDefault, so a photo dropped in the wrong place can
 * never make the window navigate away and lose the session.
 */
export function ContactSheet() {
  const rowIds = useTrackerStore(useShallow((s) => s.doc.rowIds));
  const rows = useTrackerStore((s) => s.doc.rows);
  const filters = useTrackerStore(useShallow((s) => s.filters));
  const zoom = useTrackerStore((s) => s.gridZoom);
  const setGridZoom = useTrackerStore((s) => s.setGridZoom);
  const clearSelection = useTrackerStore((s) => s.clearSelection);
  const { importFiles, importInto, progress } = useFileImport();
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Stable, so a memoised tile re-renders only when its own shot changes —
  // a fresh arrow here made every edit redraw every tile on the sheet.
  const dropInto = useCallback((rowId: string, files: FileList) => void importInto(rowId, files[0]), [importInto]);

  const visible = useMemo(() => rowIds.filter((id) => rows[id] && matchesFilters(rows[id], filters)), [rowIds, rows, filters]);

  return (
    <div className="view-col">
      <FilterBar shown={visible.length} total={rowIds.length}>
        <input
          type="range"
          className="zoom"
          min={0.6}
          max={1.8}
          step={0.1}
          value={zoom}
          onChange={(e) => setGridZoom(Number(e.target.value))}
          title="Tile size"
        />
        <button className="btn btn-primary" onClick={() => inputRef.current?.click()}>
          Add photos…
        </button>
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(e) => {
            if (e.target.files) void importFiles(e.target.files);
            e.target.value = '';
          }}
        />
      </FilterBar>
      <BatchBar />

      <div
        className={`grid-scroll ${dragOver ? 'grid-scroll-drop' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          if (e.dataTransfer.types.includes('Files')) setDragOver(true);
        }}
        onDragLeave={(e) => {
          if (e.currentTarget === e.target) setDragOver(false);
        }}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          if (e.dataTransfer.files.length > 0) void importFiles(e.dataTransfer.files);
        }}
        onClick={(e) => {
          if (e.target === e.currentTarget) clearSelection();
        }}
      >
        {rowIds.length === 0 ? (
          <div className="empty-state">
            <h2>Drop photos here</h2>
            <p className="muted">A whole folder at once is fine. Each photo becomes a shot, numbered from its filename.</p>
            <button className="btn btn-primary" onClick={() => inputRef.current?.click()}>
              Choose photos…
            </button>
          </div>
        ) : visible.length === 0 ? (
          <div className="empty-state">
            <p className="muted">No shots match these filters.</p>
          </div>
        ) : (
          <div className="grid" onClick={(e) => e.target === e.currentTarget && clearSelection()}>
            {visible.map((id) => (
              <PhotoTile key={id} rowId={id} onDropFiles={dropInto} />
            ))}
          </div>
        )}
        {dragOver && <div className="drop-veil">Drop photos to add shots</div>}
      </div>

      {progress && (
        <div className="import-progress">
          Importing {progress.done} of {progress.total}…
          <span className="bar">
            <span className="bar-fill" style={{ width: `${Math.round((progress.done / progress.total) * 100)}%` }} />
          </span>
        </div>
      )}
    </div>
  );
}
