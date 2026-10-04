import { memo } from 'react';
import { useTrackerStore } from '@/state/useTrackerStore';
import { applicableStages, openConcerns } from '@/state/selectors';
import { PIPELINE_STAGES, STAGE_LABELS, stagePath, type RowFieldPath, type ShotType, type Side, type Usage } from '@/state/schema';
import { ROW_DRAG_TYPE } from '@/components/grid/PhotoTile';

/**
 * One line of the printed sheet — editable, for anyone who prefers typing
 * across a row to the grid's click-to-inspect flow.
 *
 * A shot in both properties shows two lines of stage cells, magazine above
 * press release. A longshot's assembled/submitted/approved cells are empty:
 * those stages don't apply to it. Only the ⋮⋮ handle drags.
 */
function TrackerRowImpl({ rowId }: { rowId: string }) {
  const row = useTrackerStore((s) => s.doc.rows[rowId]);
  const thumbUrl = useTrackerStore((s) => (row?.imageHash ? s.doc.assets[row.imageHash]?.thumbUrl : undefined));
  const showThumbnails = useTrackerStore((s) => s.doc.sheet.showThumbnails);
  const selected = useTrackerStore((s) => s.selectedRowIds.includes(rowId));
  const setField = useTrackerStore((s) => s.setField);
  const toggleStage = useTrackerStore((s) => s.toggleStage);
  const toggleSelect = useTrackerStore((s) => s.toggleSelect);
  const reorderRow = useTrackerStore((s) => s.reorderRow);
  const openRow = useTrackerStore((s) => s.openRow);

  if (!row) return null;
  const stages = applicableStages(row);
  const sides: Side[] = row.usage === 'both' ? ['mag', 'pr'] : row.usage === 'mag' ? ['mag'] : row.usage === 'pr' ? ['pr'] : [];
  const concerns = openConcerns(row).length;
  const text = (path: RowFieldPath, value: string) => setField(rowId, path, value, { typing: true });

  const perSide = (render: (side: Side) => JSX.Element) =>
    sides.length === 0 ? <span className="muted">—</span> : sides.map((side) => <div key={side} className={`split split-${side}`}>{render(side)}</div>);

  return (
    <tr
      className={`sheet-row usage-${row.usage} ${selected ? 'sheet-row-selected' : ''}`}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        const dragged = e.dataTransfer.getData(ROW_DRAG_TYPE);
        if (dragged && dragged !== rowId) reorderRow(dragged, rowId);
      }}
    >
      <td className="no-print center">
        <input type="checkbox" checked={selected} onChange={() => toggleSelect(rowId)} />
      </td>
      <td
        className="no-print center drag-handle"
        draggable
        title="Drag to reorder"
        onDragStart={(e) => {
          e.dataTransfer.setData(ROW_DRAG_TYPE, rowId);
          e.dataTransfer.effectAllowed = 'move';
          const tr = (e.currentTarget as HTMLElement).closest('tr');
          if (tr) e.dataTransfer.setDragImage(tr, 10, 10);
        }}
      >
        ⋮⋮
      </td>
      {showThumbnails && (
        <td className="center">
          {thumbUrl ? <img className="sheet-thumb" src={thumbUrl} alt="" onClick={() => openRow(rowId)} /> : <span className="muted">—</span>}
        </td>
      )}
      <td>
        <input className="cell" value={row.shotNum} placeholder="Shot #" onChange={(e) => text('shotNum', e.target.value)} />
        {row.elvisName && row.elvisName !== row.shotNum && <div className="cell-sub">{row.elvisName}</div>}
      </td>
      <td>
        <select className="cell" value={row.shotType} onChange={(e) => setField(rowId, 'shotType', e.target.value as ShotType)}>
          <option value="unassigned">—</option>
          <option value="closeup">Close-up</option>
          <option value="longshot">Longshot</option>
        </select>
      </td>
      <td>
        <select className="cell" value={row.usage} onChange={(e) => setField(rowId, 'usage', e.target.value as Usage)}>
          <option value="none">—</option>
          <option value="mag">Magazine</option>
          <option value="pr">Press release</option>
          <option value="both">Both</option>
        </select>
      </td>
      <td>
        {perSide((side) => (
          <>
            {row.usage === 'both' && <span className={`track-label track-label-${side}`}>{side === 'mag' ? 'MAG' : 'PR'}</span>}
            <input
              className="cell"
              value={row[side].position}
              placeholder={side === 'mag' ? 'Spread' : 'Slide'}
              onChange={(e) => text(`${side}.position` as RowFieldPath, e.target.value)}
            />
          </>
        ))}
      </td>
      <td>
        {perSide((side) => (
          <select className="cell" value={row[side].selectType} onChange={(e) => setField(rowId, `${side}.selectType` as RowFieldPath, e.target.value)}>
            <option value="main">Main</option>
            <option value="alt">Alt</option>
          </select>
        ))}
      </td>
      <td>
        {perSide((side) => (
          <input className="cell" value={row[side].retoucher} placeholder="—" onChange={(e) => text(`${side}.retoucher` as RowFieldPath, e.target.value)} />
        ))}
      </td>
      {PIPELINE_STAGES.map((stage) => (
        <td key={stage} className="center">
          {perSide((side) =>
            stages.includes(stage) ? (
              <button
                className={`stage-cell ${row[side].pipeline[stage] ? 'stage-cell-done' : ''}`}
                title={`${STAGE_LABELS[stage]} — ${row.fieldTimes[stagePath(side, stage)]?.u ?? ''}`}
                onClick={() => toggleStage(rowId, side, stage)}
              >
                {row[side].pipeline[stage] ? '✓' : ''}
              </button>
            ) : (
              <span className="stage-cell stage-cell-skip" />
            ),
          )}
        </td>
      ))}
      <td className="no-print center">
        <button className={`concern-cell ${concerns ? 'concern-cell-open' : ''}`} onClick={() => openRow(rowId)} title="Open shot">
          {concerns ? `${concerns} ⚑` : '›'}
        </button>
      </td>
    </tr>
  );
}

export const TrackerRow = memo(TrackerRowImpl);
