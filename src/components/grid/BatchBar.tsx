import { useState } from 'react';
import { useTrackerStore, type SideTarget } from '@/state/useTrackerStore';
import { useShallow } from 'zustand/react/shallow';
import { PIPELINE_STAGES, STAGE_LABELS, type PipelineStage } from '@/state/schema';
import { useProperties } from '@/components/ui/hooks';

/**
 * Changes to many shots at once. Always aimed at one property, or on purpose
 * at every property each shot runs in: the properties are separate tracks,
 * so "mark these retouched" has to say which.
 */
export function BatchBar() {
  const selected = useTrackerStore(useShallow((s) => s.selectedRowIds));
  const batchSetStage = useTrackerStore((s) => s.batchSetStage);
  const batchSetRetoucher = useTrackerStore((s) => s.batchSetRetoucher);
  const batchSetOn = useTrackerStore((s) => s.batchSetOn);
  const deleteRows = useTrackerStore((s) => s.deleteRows);
  const clearSelection = useTrackerStore((s) => s.clearSelection);
  const properties = useProperties();
  const [chosen, setSide] = useState<SideTarget>('active');
  const [stage, setStage] = useState<PipelineStage>('retouched');
  const [retoucher, setRetoucher] = useState('');

  if (selected.length === 0) return null;
  // A property hidden since it was picked falls back to "where each runs".
  const side = chosen === 'active' || properties.some((p) => p.id === chosen) ? chosen : 'active';

  return (
    <div className="batchbar no-print">
      <span className="batch-count">{selected.length} selected</span>

      <select className="field field-select" value={side} onChange={(e) => setSide(e.target.value)} title="Which property these changes apply to">
        <option value="active">In every property it runs in</option>
        {properties.map((p) => (
          <option key={p.id} value={p.id}>
            In {p.name}
          </option>
        ))}
      </select>

      <select className="field field-select" value={stage} onChange={(e) => setStage(e.target.value as PipelineStage)}>
        {PIPELINE_STAGES.map((s) => (
          <option key={s} value={s}>
            {STAGE_LABELS[s]}
          </option>
        ))}
      </select>
      <button className="btn" onClick={() => batchSetStage(selected, side, stage, true)}>
        Mark done
      </button>
      <button className="btn btn-ghost" onClick={() => batchSetStage(selected, side, stage, false)}>
        Mark not done
      </button>

      <span className="batch-sep" />
      <input
        className="field field-sm"
        placeholder="Retoucher"
        value={retoucher}
        onChange={(e) => setRetoucher(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && retoucher.trim()) batchSetRetoucher(selected, side, retoucher.trim());
        }}
      />
      <button className="btn" disabled={!retoucher.trim()} onClick={() => batchSetRetoucher(selected, side, retoucher.trim())}>
        Assign
      </button>

      <span className="batch-sep" />
      <select
        className="field field-select"
        value=""
        onChange={(e) => {
          const [action, id] = e.target.value.split(':');
          if (id) batchSetOn(selected, id, action === 'add');
        }}
      >
        <option value="">Runs in…</option>
        <optgroup label="Add to">
          {properties.map((p) => (
            <option key={p.id} value={`add:${p.id}`}>
              {p.name}
            </option>
          ))}
        </optgroup>
        <optgroup label="Take out of">
          {properties.map((p) => (
            <option key={p.id} value={`remove:${p.id}`}>
              {p.name}
            </option>
          ))}
        </optgroup>
      </select>

      <span className="spacer" />
      <button
        className="btn btn-danger"
        onClick={() => {
          if (confirm(`Delete ${selected.length} shot(s)? Undo with ⌘Z.`)) deleteRows(selected);
        }}
      >
        Delete
      </button>
      <button className="btn btn-ghost" onClick={clearSelection}>
        Done
      </button>
    </div>
  );
}
