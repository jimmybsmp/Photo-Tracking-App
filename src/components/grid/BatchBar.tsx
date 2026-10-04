import { useState } from 'react';
import { useTrackerStore, type SideTarget } from '@/state/useTrackerStore';
import { useShallow } from 'zustand/react/shallow';
import { PIPELINE_STAGES, STAGE_LABELS, type PipelineStage } from '@/state/schema';

/**
 * Changes to many shots at once. Always aimed at one property (or both, on
 * purpose): magazine and press release are separate tracks, so "mark these
 * retouched" has to say which.
 */
export function BatchBar() {
  const selected = useTrackerStore(useShallow((s) => s.selectedRowIds));
  const batchSetStage = useTrackerStore((s) => s.batchSetStage);
  const batchSetRetoucher = useTrackerStore((s) => s.batchSetRetoucher);
  const batchSetField = useTrackerStore((s) => s.batchSetField);
  const deleteRows = useTrackerStore((s) => s.deleteRows);
  const clearSelection = useTrackerStore((s) => s.clearSelection);
  const [side, setSide] = useState<SideTarget>('mag');
  const [stage, setStage] = useState<PipelineStage>('retouched');
  const [retoucher, setRetoucher] = useState('');

  if (selected.length === 0) return null;

  return (
    <div className="batchbar no-print">
      <span className="batch-count">{selected.length} selected</span>

      <div className="segmented">
        {(['mag', 'pr', 'both'] as SideTarget[]).map((s) => (
          <button key={s} className={side === s ? 'seg-active' : ''} onClick={() => setSide(s)}>
            {s === 'mag' ? 'Magazine' : s === 'pr' ? 'Press release' : 'Both'}
          </button>
        ))}
      </div>

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
          const usage = e.target.value;
          if (usage) batchSetField(selected, 'usage', usage);
        }}
      >
        <option value="">Set usage…</option>
        <option value="mag">Magazine</option>
        <option value="pr">Press release</option>
        <option value="both">Both</option>
        <option value="none">None</option>
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
