import { memo, useState } from 'react';
import { useTrackerStore } from '@/state/useTrackerStore';
import { activeSides, openConcerns } from '@/state/selectors';
import { StageTrack } from '@/components/ui/StageTrack';

export const ROW_DRAG_TYPE = 'application/x-phototrack-row';

/**
 * One shot on the contact sheet.
 *
 * Only the ⋮⋮ handle is draggable. When the whole tile was `draggable`, the
 * slightest mouse movement during a click on its checkbox or a button
 * started a drag instead — buttons that "sometimes don't work". Photos are
 * still dropped anywhere on the tile to replace its picture.
 *
 * Renders its own row from the store by id, so editing one shot re-renders
 * only that tile.
 */
function PhotoTileImpl({ rowId, onDropFiles }: { rowId: string; onDropFiles: (rowId: string, files: FileList) => void }) {
  const row = useTrackerStore((s) => s.doc.rows[rowId]);
  const thumbUrl = useTrackerStore((s) => (row?.imageHash ? s.doc.assets[row.imageHash]?.thumbUrl : undefined));
  const selected = useTrackerStore((s) => s.selectedRowIds.includes(rowId));
  const active = useTrackerStore((s) => s.activeRowId === rowId);
  const zoom = useTrackerStore((s) => s.gridZoom);
  const toggleSelect = useTrackerStore((s) => s.toggleSelect);
  const openRow = useTrackerStore((s) => s.openRow);
  const reorderRow = useTrackerStore((s) => s.reorderRow);
  const [over, setOver] = useState(false);

  if (!row) return null;
  const sides = activeSides(row);
  const concerns = openConcerns(row).length;
  const width = Math.round(200 * zoom);

  return (
    <div
      className={['tile', selected && 'tile-selected', active && 'tile-active', over && 'tile-drop'].filter(Boolean).join(' ')}
      style={{ width }}
      onClick={(e) => {
        // A plain click opens the shot; selecting for batch changes is
        // deliberate — the checkbox, or ⌘/⇧-click.
        if (e.metaKey || e.ctrlKey || e.shiftKey) toggleSelect(rowId);
        else openRow(rowId);
      }}
      onDragOver={(e) => {
        e.preventDefault();
        e.stopPropagation();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        e.stopPropagation();
        setOver(false);
        const dragged = e.dataTransfer.getData(ROW_DRAG_TYPE);
        if (dragged) {
          if (dragged !== rowId) reorderRow(dragged, rowId);
        } else if (e.dataTransfer.files.length) {
          onDropFiles(rowId, e.dataTransfer.files);
        }
      }}
    >
      <div className="tile-thumb" style={{ height: Math.round(width * 0.66) }}>
        {thumbUrl ? <img src={thumbUrl} alt="" draggable={false} /> : <span className="tile-empty">No photo — drop one here</span>}
        <label className="tile-check" onClick={(e) => e.stopPropagation()} title="Select for batch changes">
          <input type="checkbox" checked={selected} onChange={() => toggleSelect(rowId)} />
        </label>
        {concerns > 0 && (
          <span className="tile-concerns" title={`${concerns} open concern${concerns === 1 ? '' : 's'}`}>
            {concerns}
          </span>
        )}
        {row.elvisAssetId && <span className="tile-elvis" title={`In Elvis: ${row.elvisPath || ''}`}>E</span>}
      </div>

      <div className="tile-meta">
        <span
          className="drag-handle"
          draggable
          title="Drag to reorder"
          onClick={(e) => e.stopPropagation()}
          onDragStart={(e) => {
            e.dataTransfer.setData(ROW_DRAG_TYPE, rowId);
            e.dataTransfer.effectAllowed = 'move';
            const tile = (e.currentTarget as HTMLElement).closest('.tile');
            if (tile) e.dataTransfer.setDragImage(tile, 20, 20);
          }}
        >
          ⋮⋮
        </span>
        <span className="tile-shotnum" title={row.elvisName || undefined}>
          {row.shotNum || row.elvisName || 'No shot #'}
        </span>
        {row.shotType === 'longshot' && <span className="pill pill-neutral">LS</span>}
      </div>

      <div className="tile-tracks">
        {sides.length === 0 ? (
          <span className="tile-nousage">Set magazine / press release</span>
        ) : (
          sides.map((side) => <StageTrack key={side} row={row} side={side} />)
        )}
      </div>
    </div>
  );
}

export const PhotoTile = memo(PhotoTileImpl);
