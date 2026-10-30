import { memo, type CSSProperties } from 'react';
import { useTrackerStore } from '@/state/useTrackerStore';
import { activeSides, applicableStages, openConcerns } from '@/state/selectors';
import { propertyStyle } from '@/state/properties';
import { PIPELINE_STAGES, STAGE_LABELS, stagePath, trackOf, trackPath, type PropertyDef, type RowFieldPath, type ShotType } from '@/state/schema';
import { ROW_DRAG_TYPE } from '@/components/grid/PhotoTile';
import { useProperties } from '@/components/ui/hooks';

/**
 * One line of the printed sheet — editable, for anyone who prefers typing
 * across a row to the grid's click-to-inspect flow.
 *
 * A shot in several properties shows a line of cells per property, in the
 * project's order. A longshot's assembled/submitted/approved cells are empty:
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
  const properties = useProperties();

  if (!row) return null;
  const stages = applicableStages(row);
  const active = activeSides(row, properties);
  const live = properties.filter((p) => active.includes(p.id));
  const concerns = openConcerns(row).length;
  const text = (path: RowFieldPath, value: string) => setField(rowId, path, value, { typing: true });

  const perSide = (render: (prop: PropertyDef) => JSX.Element) =>
    live.length === 0 ? (
      <span className="muted">—</span>
    ) : (
      live.map((prop) => (
        <div key={prop.id} className="split" style={propertyStyle(prop.color) as CSSProperties}>
          {render(prop)}
        </div>
      ))
    );

  return (
    <tr
      className={`sheet-row ${selected ? 'sheet-row-selected' : ''}`}
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
        <div className="runs-in-cell">
          {properties.map((prop) => {
            const on = active.includes(prop.id);
            return (
              <button
                key={prop.id}
                className={`track-label run-tag ${on ? 'run-tag-on' : 'run-tag-off no-print'}`}
                style={propertyStyle(prop.color) as CSSProperties}
                title={`${on ? 'Take out of' : 'Add to'} ${prop.name}`}
                onClick={() => setField(rowId, trackPath(prop.id, 'on'), !on)}
              >
                {prop.short}
              </button>
            );
          })}
        </div>
      </td>
      <td>
        {perSide((prop) => (
          <>
            {live.length > 1 && <span className="track-label">{prop.short}</span>}
            <input
              className="cell"
              value={trackOf(row, prop.id).position}
              placeholder={prop.positionLabel.replace(/\s*#$/, '')}
              onChange={(e) => text(trackPath(prop.id, 'position'), e.target.value)}
            />
          </>
        ))}
      </td>
      <td>
        {perSide(({ id: side }) => (
          <select className="cell" value={trackOf(row, side).selectType} onChange={(e) => setField(rowId, trackPath(side, 'selectType'), e.target.value)}>
            <option value="main">Main</option>
            <option value="alt">Alt</option>
          </select>
        ))}
      </td>
      <td>
        {perSide(({ id: side }) => (
          <input className="cell" value={trackOf(row, side).retoucher} placeholder="—" onChange={(e) => text(trackPath(side, 'retoucher'), e.target.value)} />
        ))}
      </td>
      {PIPELINE_STAGES.map((stage) => (
        <td key={stage} className="center">
          {perSide(({ id: side }) =>
            stages.includes(stage) ? (
              <button
                className={`stage-cell ${trackOf(row, side).pipeline[stage] ? 'stage-cell-done' : ''}`}
                title={`${STAGE_LABELS[stage]} — ${row.fieldTimes[stagePath(side, stage)]?.u ?? ''}`}
                onClick={() => toggleStage(rowId, side, stage)}
              >
                {trackOf(row, side).pipeline[stage] ? '✓' : ''}
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
