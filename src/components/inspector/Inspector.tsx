import { useRef } from 'react';
import { useTrackerStore } from '@/state/useTrackerStore';
import { activeSides, applicableStages, nextStage, sideProgress } from '@/state/selectors';
import { SIDE_LABELS, STAGE_LABELS, stagePath, type RowFieldPath, type ShotRow, type ShotType, type Side, type Usage } from '@/state/schema';
import { stampTime } from '@/lib/format';
import { useFileImport } from '@/components/grid/useFileImport';
import { CommentThread } from './CommentThread';
import { ElvisLink } from './ElvisLink';

/**
 * Everything about one shot. Switching usage or shot type is purely a display
 * decision: hiding a property, or a longshot's last three stages, never
 * clears what was entered — switching back shows the same values again.
 */
export function Inspector() {
  const rowId = useTrackerStore((s) => s.activeRowId);
  const row = useTrackerStore((s) => (rowId ? s.doc.rows[rowId] : undefined));
  // A picture shared from another site before it reached Elvis is thumbnail-only.
  const reviewUrl = useTrackerStore((s) => {
    const asset = row?.imageHash ? s.doc.assets[row.imageHash] : undefined;
    return asset ? asset.reviewUrl || asset.thumbUrl : undefined;
  });
  const setField = useTrackerStore((s) => s.setField);
  const openRow = useTrackerStore((s) => s.openRow);
  const deleteRows = useTrackerStore((s) => s.deleteRows);
  const { importInto } = useFileImport();
  const fileRef = useRef<HTMLInputElement>(null);

  if (!row || !rowId) return null;
  const sides = activeSides(row);
  const text = (path: RowFieldPath, value: string) => setField(rowId, path, value, { typing: true });

  return (
    <aside className="inspector no-print">
      <div className="inspector-head">
        <div>
          <h2>{row.shotNum || row.elvisName || 'Untitled shot'}</h2>
          {row.elvisAssetId && (
            <span className="muted small" title={row.elvisAssetId}>
              In Elvis · {row.elvisName}
            </span>
          )}
        </div>
        <button className="icon-btn" onClick={() => openRow(null)} title="Close (Esc)">
          ✕
        </button>
      </div>

      <div className="inspector-scroll">
        <div className="preview">
          {reviewUrl ? <img src={reviewUrl} alt="" /> : <div className="preview-empty">No photo</div>}
          <button className="btn btn-sm" onClick={() => fileRef.current?.click()}>
            {reviewUrl ? 'Replace photo' : 'Add photo'}
          </button>
          <input ref={fileRef} type="file" accept="image/*" hidden onChange={(e) => void importInto(rowId, e.target.files?.[0])} />
        </div>

        <ElvisLink row={row} />

        <div className="form-grid">
          <label className="field-label">
            <span>Shot #</span>
            <input className="field" value={row.shotNum} onChange={(e) => text('shotNum', e.target.value)} placeholder="e.g. 02C1234" />
          </label>
          <label className="field-label">
            <span>Shot type</span>
            <select className="field field-select" value={row.shotType} onChange={(e) => setField(rowId, 'shotType', e.target.value as ShotType)}>
              <option value="unassigned">Not set</option>
              <option value="closeup">Close-up</option>
              <option value="longshot">Longshot</option>
            </select>
          </label>
        </div>

        <div className="field-label">
          <span>Runs in</span>
          <div className="segmented">
            {(
              [
                ['mag', 'Magazine'],
                ['pr', 'Press release'],
                ['both', 'Both'],
                ['none', 'Neither yet'],
              ] as Array<[Usage, string]>
            ).map(([value, label]) => (
              <button key={value} className={row.usage === value ? 'seg-active' : ''} onClick={() => setField(rowId, 'usage', value)}>
                {label}
              </button>
            ))}
          </div>
        </div>

        {sides.map((side) => (
          <PropertySection key={side} row={row} side={side} />
        ))}
        {sides.length === 0 && <p className="muted small">Choose where this shot runs to track its progress.</p>}

        <label className="field-label">
          <span>Description</span>
          <textarea className="field" rows={2} value={row.notes} onChange={(e) => text('notes', e.target.value)} placeholder="What the shot is, anything fixed about it…" />
        </label>

        <section className="inspector-section">
          <h3>Notes &amp; concerns</h3>
          <CommentThread key={row.id} row={row} />
        </section>

        <button
          className="btn btn-danger btn-sm delete-shot"
          onClick={() => {
            if (confirm('Delete this shot? Undo with ⌘Z.')) deleteRows([rowId]);
          }}
        >
          Delete shot
        </button>
      </div>
    </aside>
  );
}

function PropertySection({ row, side }: { row: ShotRow; side: Side }) {
  const setField = useTrackerStore((s) => s.setField);
  const toggleStage = useTrackerStore((s) => s.toggleStage);
  const stages = applicableStages(row);
  const next = nextStage(row, side);
  const { done, total } = sideProgress(row, side);
  const p = row[side];
  const text = (path: RowFieldPath, value: string) => setField(row.id, path, value, { typing: true });

  return (
    <section className={`property-section property-${side}`}>
      <header>
        <h3>{SIDE_LABELS[side]}</h3>
        <span className={`status-text ${next ? '' : 'status-complete'}`}>{next ? `Waiting on ${STAGE_LABELS[next]}` : 'Complete'}</span>
        <span className="muted small">
          {done}/{total}
        </span>
      </header>

      <div className="form-grid">
        <label className="field-label">
          <span>{side === 'mag' ? 'Spread #' : 'Slide #'}</span>
          <input className="field" value={p.position} onChange={(e) => text(`${side}.position` as RowFieldPath, e.target.value)} />
        </label>
        <label className="field-label">
          <span>Select</span>
          <select className="field field-select" value={p.selectType} onChange={(e) => setField(row.id, `${side}.selectType` as RowFieldPath, e.target.value)}>
            <option value="main">Main select</option>
            <option value="alt">Alt shot</option>
          </select>
        </label>
        <label className="field-label form-span">
          <span>Retoucher</span>
          <input className="field" value={p.retoucher} onChange={(e) => text(`${side}.retoucher` as RowFieldPath, e.target.value)} placeholder="Name or initials" />
        </label>
      </div>

      <ul className="checklist">
        {stages.map((stage, i) => {
          const isDone = p.pipeline[stage];
          const stamp = row.fieldTimes[stagePath(side, stage)];
          return (
            <li key={stage}>
              <button className={`check ${isDone ? 'check-done' : ''} ${stage === next ? 'check-next' : ''}`} onClick={() => toggleStage(row.id, side, stage)}>
                <span className="check-box">{isDone ? '✓' : ''}</span>
                <span className="check-label">{STAGE_LABELS[stage]}</span>
                <span className="check-key muted small" title="Keyboard shortcut">
                  {side === 'pr' && row.usage === 'both' ? '⇧' : ''}
                  {i + 1}
                </span>
              </button>
              {stamp?.u && stamp.t > 1 && (
                <span className="check-who muted small">
                  {isDone ? '' : 'unchecked · '}
                  {stamp.u} · {stampTime(stamp.t)}
                </span>
              )}
            </li>
          );
        })}
      </ul>
      {row.shotType === 'longshot' && <p className="muted small">Longshot — assembly, submission and approval don't apply.</p>}
    </section>
  );
}
