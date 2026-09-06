import { useTrackerStore } from '@/state/useTrackerStore';
import { applicableStages } from '@/state/selectors';
import { importImageFile } from '@/lib/images';
import { TextInput } from '@/components/ui/controls';
import { PipelineToggle } from '@/components/ui/PipelineToggle';
import { PIPELINE_STAGES, type RowFieldPath, type ShotType, type Usage } from '@/state/schema';
import type { Side } from '@/state/selectors';

/**
 * Full editor for one row. Every field switch here is deliberately non-
 * destructive: switching usage away from a side, or a shot to a longshot,
 * never clears that side's position, retoucher, or pipeline state — the old
 * tool cleared the position field on a usage switch and reset three pipeline
 * toggles on every load for a longshot. Switching back always shows the same
 * values that were there before.
 */
export function Inspector() {
  const activeRowId = useTrackerStore((s) => s.activeRowId);
  const row = useTrackerStore((s) => (activeRowId ? s.doc.rows[activeRowId] : undefined));
  const asset = useTrackerStore((s) => (row?.imageHash ? s.doc.assets[row.imageHash] : undefined));
  const setField = useTrackerStore((s) => s.setField);
  const setUsage = useTrackerStore((s) => s.setUsage);
  const setShotType = useTrackerStore((s) => s.setShotType);
  const togglePipeline = useTrackerStore((s) => s.togglePipeline);
  const assignImage = useTrackerStore((s) => s.assignImage);
  const deleteRows = useTrackerStore((s) => s.deleteRows);
  const setActiveRow = useTrackerStore((s) => s.setActiveRow);

  if (!row || !activeRowId) return null;
  const rowId = activeRowId;

  const stages = applicableStages(row);
  const sidesToShow: Side[] = row.usage === 'both' ? ['mag', 'pr'] : row.usage === 'pr' ? ['pr'] : row.usage === 'mag' ? ['mag'] : [];

  async function handleReplace(file: File | undefined) {
    if (!file) return;
    try {
      const asset = await importImageFile(file);
      assignImage(rowId, asset);
    } catch (err) {
      console.warn('Could not import image', file.name, err);
    }
  }

  return (
    <aside className="inspector">
      <div className="inspector-header">
        <h2>Shot {row.shotNum || '—'}</h2>
        <button type="button" className="btn-icon" onClick={() => setActiveRow(null)} title="Close">
          ✕
        </button>
      </div>

      <div className="inspector-preview">
        {asset ? <img src={asset.reviewUrl} alt="" /> : <div className="inspector-preview-empty">No photo yet</div>}
        <label className="btn btn-sm">
          {asset ? 'Replace photo' : 'Add photo'}
          <input
            type="file"
            accept="image/*"
            style={{ display: 'none' }}
            onChange={(e) => void handleReplace(e.target.files?.[0])}
          />
        </label>
      </div>

      <label className="inspector-field">
        <span>Shot #</span>
        <TextInput
          value={row.shotNum}
          placeholder="e.g. 02C1234"
          onChange={(e) => setField(rowId, 'shotNum', e.target.value)}
        />
      </label>

      <label className="inspector-field">
        <span>Shot type</span>
        <select className="field" value={row.shotType} onChange={(e) => setShotType(rowId, e.target.value as ShotType)}>
          <option value="unassigned">— Select —</option>
          <option value="longshot">Longshot</option>
          <option value="closeup">Close-up</option>
        </select>
      </label>

      <label className="inspector-field">
        <span>Usage placement</span>
        <select className="field" value={row.usage} onChange={(e) => setUsage(rowId, e.target.value as Usage)}>
          <option value="none">— Unassigned —</option>
          <option value="mag">Magazine</option>
          <option value="pr">Press release</option>
          <option value="both">Both</option>
        </select>
      </label>

      {sidesToShow.length === 0 && (
        <p className="inspector-hint">Set a usage placement to track spread/slide number, retoucher, and pipeline for this shot.</p>
      )}

      {sidesToShow.map((side) => (
        <div key={side} className="inspector-side">
          <h3>{side === 'mag' ? 'Magazine' : 'Press release'}</h3>

          <label className="inspector-field">
            <span>{side === 'mag' ? 'Spread #' : 'Slide #'}</span>
            <TextInput
              value={row[side].position}
              onChange={(e) => setField(rowId, `${side}.position` as RowFieldPath, e.target.value)}
            />
          </label>

          <label className="inspector-field">
            <span>Select type</span>
            <select
              className="field"
              value={row[side].selectType}
              onChange={(e) => setField(rowId, `${side}.selectType` as RowFieldPath, e.target.value)}
            >
              <option value="main">Main select</option>
              <option value="alt">Alt shot</option>
            </select>
          </label>

          <label className="inspector-field">
            <span>Retoucher</span>
            <TextInput
              value={row[side].retoucher}
              placeholder="Initials / name"
              onChange={(e) => setField(rowId, `${side}.retoucher` as RowFieldPath, e.target.value)}
            />
          </label>

          <div className="inspector-pipeline">
            {PIPELINE_STAGES.map((stage) => (
              <PipelineToggle
                key={stage}
                stage={stage}
                done={row[side].pipeline[stage]}
                applicable={stages.includes(stage)}
                onToggle={() => togglePipeline(rowId, side, stage)}
              />
            ))}
          </div>
        </div>
      ))}

      <label className="inspector-field">
        <span>Notes</span>
        <textarea
          className="field"
          rows={3}
          value={row.notes}
          onChange={(e) => setField(rowId, 'notes', e.target.value)}
        />
      </label>

      {row.elvisAssetId && <p className="inspector-hint">WoodWing Elvis asset: {row.elvisAssetId}</p>}

      <button
        type="button"
        className="btn btn-danger"
        onClick={() => {
          if (confirm('Delete this shot? Undo with Cmd+Z.')) deleteRows([rowId]);
        }}
      >
        Delete shot
      </button>
    </aside>
  );
}
