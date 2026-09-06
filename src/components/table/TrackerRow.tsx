import { memo } from 'react';
import { useTrackerStore } from '@/state/useTrackerStore';
import { applicableStages } from '@/state/selectors';
import { PipelineToggle } from '@/components/ui/PipelineToggle';
import { PIPELINE_STAGES, type RowFieldPath, type ShotType, type Usage } from '@/state/schema';

const ROW_DRAG_TYPE = 'application/x-phototrack-row';

/**
 * One line of the printed sheet. Kept editable — the sheet is the closest
 * equivalent to the original tool's spreadsheet-style entry, for anyone who
 * prefers typing across a row to the grid's click-to-inspect flow — and it
 * doubles as the layout the tabloid print stylesheet targets.
 */
function TrackerRowImpl({ rowId }: { rowId: string }) {
  const row = useTrackerStore((s) => s.doc.rows[rowId]);
  const asset = useTrackerStore((s) => (row?.imageHash ? s.doc.assets[row.imageHash] : undefined));
  const selected = useTrackerStore((s) => s.selectedRowIds.includes(rowId));
  const showThumbnails = useTrackerStore((s) => s.doc.sheet.showThumbnails);
  const setField = useTrackerStore((s) => s.setField);
  const setUsage = useTrackerStore((s) => s.setUsage);
  const setShotType = useTrackerStore((s) => s.setShotType);
  const togglePipeline = useTrackerStore((s) => s.togglePipeline);
  const toggleSelect = useTrackerStore((s) => s.toggleSelect);
  const deleteRows = useTrackerStore((s) => s.deleteRows);
  const reorderRow = useTrackerStore((s) => s.reorderRow);

  if (!row) return null;
  const stages = applicableStages(row);
  const showMag = row.usage === 'mag' || row.usage === 'both';
  const showPr = row.usage === 'pr' || row.usage === 'both';

  return (
    <tr
      className={[
        'sheet-row',
        selected && 'sheet-row-selected',
        row.usage === 'mag' && 'sheet-row-mag',
        row.usage === 'pr' && 'sheet-row-pr',
        row.usage === 'both' && 'sheet-row-both',
      ]
        .filter(Boolean)
        .join(' ')}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(ROW_DRAG_TYPE, rowId);
        e.dataTransfer.effectAllowed = 'move';
      }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        const draggedRowId = e.dataTransfer.getData(ROW_DRAG_TYPE);
        if (draggedRowId && draggedRowId !== rowId) reorderRow(draggedRowId, rowId);
      }}
    >
      <td className="no-print sheet-cell-center">
        <input type="checkbox" checked={selected} onChange={() => toggleSelect(rowId, true)} />
      </td>
      <td className="no-print sheet-cell-center sheet-drag-handle" title="Drag to reorder">
        ⋮⋮
      </td>

      {showThumbnails && (
        <td className="sheet-cell-center">
          {asset ? <img className="sheet-thumb" src={asset.thumbUrl} alt="" /> : <span className="sheet-thumb-empty">—</span>}
        </td>
      )}

      <td>
        <input
          className="cell-input"
          value={row.shotNum}
          placeholder="e.g. 02C1234"
          onChange={(e) => setField(rowId, 'shotNum', e.target.value)}
        />
      </td>

      <td>
        <select className="cell-select" value={row.shotType} onChange={(e) => setShotType(rowId, e.target.value as ShotType)}>
          <option value="unassigned">— Select —</option>
          <option value="longshot">Longshot</option>
          <option value="closeup">Close-Up</option>
        </select>
      </td>

      <td>
        <select className="cell-select" value={row.usage} onChange={(e) => setUsage(rowId, e.target.value as Usage)}>
          <option value="none">— Unassigned —</option>
          <option value="mag">Magazine</option>
          <option value="pr">Press Release</option>
          <option value="both">Both</option>
        </select>
      </td>

      <td>
        {showMag && (
          <div className="split-row">
            {row.usage === 'both' && <span className="dest-tag dest-mag">MAG</span>}
            <input
              className="cell-input"
              placeholder="Spread #"
              value={row.mag.position}
              onChange={(e) => setField(rowId, 'mag.position' as RowFieldPath, e.target.value)}
            />
          </div>
        )}
        {showPr && (
          <div className="split-row split-divider">
            {row.usage === 'both' && <span className="dest-tag dest-pr">PR</span>}
            <input
              className="cell-input"
              placeholder="Slide #"
              value={row.pr.position}
              onChange={(e) => setField(rowId, 'pr.position' as RowFieldPath, e.target.value)}
            />
          </div>
        )}
        {!showMag && !showPr && <span className="sheet-thumb-empty">—</span>}
      </td>

      <td>
        {showMag && (
          <div className="split-row">
            <select
              className="cell-select"
              value={row.mag.selectType}
              onChange={(e) => setField(rowId, 'mag.selectType' as RowFieldPath, e.target.value)}
            >
              <option value="main">Main Select</option>
              <option value="alt">Alt Shot</option>
            </select>
          </div>
        )}
        {showPr && (
          <div className="split-row split-divider">
            <select
              className="cell-select"
              value={row.pr.selectType}
              onChange={(e) => setField(rowId, 'pr.selectType' as RowFieldPath, e.target.value)}
            >
              <option value="main">Main Select</option>
              <option value="alt">Alt Shot</option>
            </select>
          </div>
        )}
      </td>

      <td>
        {showMag && (
          <div className="split-row">
            <input
              className="cell-input"
              placeholder="Initials"
              value={row.mag.retoucher}
              onChange={(e) => setField(rowId, 'mag.retoucher' as RowFieldPath, e.target.value)}
            />
          </div>
        )}
        {showPr && (
          <div className="split-row split-divider">
            <input
              className="cell-input"
              placeholder="Initials"
              value={row.pr.retoucher}
              onChange={(e) => setField(rowId, 'pr.retoucher' as RowFieldPath, e.target.value)}
            />
          </div>
        )}
      </td>

      {PIPELINE_STAGES.map((stage) => (
        <td key={stage} className="sheet-cell-center">
          {showMag && (
            <PipelineToggle
              compact
              stage={stage}
              applicable={stages.includes(stage)}
              done={row.mag.pipeline[stage]}
              onToggle={() => togglePipeline(rowId, 'mag', stage)}
            />
          )}
          {showPr && (
            <PipelineToggle
              compact
              stage={stage}
              applicable={stages.includes(stage)}
              done={row.pr.pipeline[stage]}
              onToggle={() => togglePipeline(rowId, 'pr', stage)}
            />
          )}
        </td>
      ))}

      <td className="no-print sheet-cell-center">
        <button
          type="button"
          className="del-btn"
          title="Delete row"
          onClick={() => {
            if (confirm('Delete this shot? Undo with Cmd+Z.')) deleteRows([rowId]);
          }}
        >
          ✕
        </button>
      </td>
    </tr>
  );
}

export const TrackerRow = memo(TrackerRowImpl);
