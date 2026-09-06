import { memo, useRef, useState } from 'react';
import { useTrackerStore } from '@/state/useTrackerStore';
import { activeSides, applicableStages, isStalled } from '@/state/selectors';
import { importImageFile } from '@/lib/images';
import { Pill } from '@/components/ui/controls';
import { PIPELINE_STAGES, type PipelineStage } from '@/state/schema';

const ROW_DRAG_TYPE = 'application/x-phototrack-row';

const STAGE_LABEL: Record<PipelineStage, string> = {
  retouched: 'R',
  qc: 'QC',
  assembled: 'A',
  submitted: 'S',
  approved: 'AP',
};

/**
 * One tile on the contact sheet. Renders its own row from the store by id
 * (not from a list the parent passes down), so dragging or editing one tile
 * never re-renders its neighbours — the same reasoning as OpticPlan's
 * per-object subscriptions.
 */
function PhotoTileImpl({ rowId }: { rowId: string }) {
  const row = useTrackerStore((s) => s.doc.rows[rowId]);
  const asset = useTrackerStore((s) => (row?.imageHash ? s.doc.assets[row.imageHash] : undefined));
  const selected = useTrackerStore((s) => s.selectedRowIds.includes(rowId));
  const active = useTrackerStore((s) => s.activeRowId === rowId);
  const zoom = useTrackerStore((s) => s.gridZoom);
  const toggleSelect = useTrackerStore((s) => s.toggleSelect);
  const select = useTrackerStore((s) => s.select);
  const setActiveRow = useTrackerStore((s) => s.setActiveRow);
  const assignImage = useTrackerStore((s) => s.assignImage);
  const reorderRow = useTrackerStore((s) => s.reorderRow);

  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  if (!row) return null;

  const sides = activeSides(row);
  const stages = applicableStages(row);
  const stalledSide = sides.find((side) => isStalled(row, side));

  async function handleFile(file: File | undefined) {
    if (!file || !file.type.startsWith('image/')) return;
    try {
      const asset = await importImageFile(file);
      assignImage(rowId, asset);
    } catch (err) {
      console.warn('Could not import image', file.name, err);
    }
  }

  const size = Math.round(180 * zoom);

  return (
    <div
      className={[
        'tile',
        selected && 'tile-selected',
        active && 'tile-active',
        dragOver && 'tile-drag-over',
      ]
        .filter(Boolean)
        .join(' ')}
      style={{ width: size }}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(ROW_DRAG_TYPE, rowId);
        e.dataTransfer.effectAllowed = 'move';
      }}
      onDragOver={(e) => {
        // Without this, dropping anywhere that isn't exactly a drop target
        // falls through to the browser's default: navigating the window to
        // the dropped file, discarding the whole session. Every drop target
        // in this app calls preventDefault unconditionally for that reason.
        e.preventDefault();
        e.stopPropagation();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        e.stopPropagation();
        setDragOver(false);
        const draggedRowId = e.dataTransfer.getData(ROW_DRAG_TYPE);
        if (draggedRowId && draggedRowId !== rowId) {
          reorderRow(draggedRowId, rowId);
          return;
        }
        void handleFile(e.dataTransfer.files[0]);
      }}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey) toggleSelect(rowId, true);
        else select([rowId]);
        setActiveRow(rowId);
      }}
    >
      <div className="tile-thumb" style={{ height: Math.round(size * 0.7) }}>
        {asset ? (
          <img src={asset.thumbUrl} alt="" draggable={false} />
        ) : (
          <button
            type="button"
            className="tile-empty"
            onClick={(e) => {
              e.stopPropagation();
              inputRef.current?.click();
            }}
          >
            Click or drop photo
          </button>
        )}
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          className="tile-file-input"
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => void handleFile(e.target.files?.[0])}
        />
        <label className="tile-checkbox" onClick={(e) => e.stopPropagation()}>
          <input type="checkbox" checked={selected} onChange={() => toggleSelect(rowId, true)} />
        </label>
        {stalledSide && (
          <span className="tile-warning" title={`${stalledSide === 'mag' ? 'Magazine' : 'Press'} side: retouched but not QC'd`}>
            ⚠
          </span>
        )}
      </div>

      <div className="tile-meta">
        <span className="tile-shotnum">{row.shotNum || '—'}</span>
        <div className="tile-tags">
          {(row.usage === 'mag' || row.usage === 'both') && <Pill tone="mag">MAG</Pill>}
          {(row.usage === 'pr' || row.usage === 'both') && <Pill tone="pr">PR</Pill>}
          {row.shotType === 'longshot' && <Pill tone="neutral">LS</Pill>}
        </div>
      </div>

      <div className="tile-stages">
        {PIPELINE_STAGES.filter((stage) => stages.includes(stage)).map((stage) => {
          const done = sides.length > 0 && sides.every((side) => row[side].pipeline[stage]);
          return (
            <span key={stage} className={`stage-dot ${done ? 'stage-dot-done' : ''}`} title={stage}>
              {STAGE_LABEL[stage]}
            </span>
          );
        })}
      </div>
    </div>
  );
}

/** Memoized so a parent re-render (any edit anywhere in the doc) doesn't
 *  re-execute every tile — each tile still updates on its own row change,
 *  since that comes through its own store subscriptions, not through props. */
export const PhotoTile = memo(PhotoTileImpl);
