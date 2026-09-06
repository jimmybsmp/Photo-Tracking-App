import { useMemo, useState } from 'react';
import { useTrackerStore } from '@/state/useTrackerStore';
import { useShallow } from 'zustand/react/shallow';
import { matchesFilters } from '@/state/selectors';
import { PhotoTile } from './PhotoTile';
import { useFileImport } from './useFileImport';

/**
 * The contact sheet: a light-table grid of every shot. Dropping photos
 * anywhere on it imports them and creates rows — the single biggest fix over
 * the tool this replaces, whose window-level drop handler only called
 * `preventDefault()` inside its one `.json` branch, so dropping an actual
 * photo anywhere but a specific 140×90 cell handed it to the browser's
 * default handling: navigate the tab to the image file, discarding
 * everything unsaved. Every handler here calls `preventDefault`
 * unconditionally, and the empty-state and background both accept drops.
 */
export function ContactSheet() {
  const rowIds = useTrackerStore(useShallow((s) => s.doc.rowIds));
  const filters = useTrackerStore(useShallow((s) => s.filters));
  const rowsVersion = useTrackerStore((s) => s.revision);
  const clearSelection = useTrackerStore((s) => s.clearSelection);
  const { importFiles, progress, lastSkipped } = useFileImport();
  const [dragOver, setDragOver] = useState(false);

  const visibleIds = useMemo(() => {
    const doc = useTrackerStore.getState().doc;
    return rowIds.filter((id) => {
      const row = doc.rows[id];
      return row ? matchesFilters(row, filters) : false;
      // eslint-disable-next-line react-hooks/exhaustive-deps
    });
    // rowsVersion forces recompute on any field edit (usage/shotType/search
    // fields can change without rowIds itself changing).
  }, [rowIds, filters, rowsVersion]);

  return (
    <div
      className="sheet-scroll"
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
      {visibleIds.length === 0 ? (
        <EmptyState onImport={importFiles} filtered={rowIds.length > 0} />
      ) : (
        <div className={`grid-wrap ${dragOver ? 'grid-wrap-drag-over' : ''}`}>
          {visibleIds.map((id) => (
            <PhotoTile key={id} rowId={id} />
          ))}
        </div>
      )}

      {dragOver && <div className="drop-veil">Drop photos to add shots</div>}
      {progress && (
        <div className="import-toast">
          Importing {progress.done}/{progress.total}…
        </div>
      )}
      {!progress && lastSkipped > 0 && (
        <div className="import-toast import-toast-fade">
          {lastSkipped} already tracked, skipped
        </div>
      )}
    </div>
  );
}

function EmptyState({ onImport, filtered }: { onImport: (files: FileList) => void; filtered: boolean }) {
  return (
    <div className="empty-state">
      {filtered ? (
        <p>No shots match the current filters.</p>
      ) : (
        <>
          <p>Drop photos anywhere on this page to start tracking them.</p>
          <label className="btn btn-primary">
            Choose photos…
            <input
              type="file"
              accept="image/*"
              multiple
              style={{ display: 'none' }}
              onChange={(e) => {
                if (e.target.files) onImport(e.target.files);
                e.target.value = '';
              }}
            />
          </label>
        </>
      )}
    </div>
  );
}
