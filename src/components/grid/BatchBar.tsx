import { useState } from 'react';
import { useTrackerStore } from '@/state/useTrackerStore';
import { useShallow } from 'zustand/react/shallow';
import { PIPELINE_STAGES } from '@/state/schema';

const STAGE_LABELS: Record<string, string> = {
  retouched: 'Retouched',
  qc: 'QC',
  assembled: 'Assembled',
  submitted: 'Submitted',
  approved: 'Approved',
};

/** Multi-row actions, shown whenever more than the active row is selected. */
export function BatchBar() {
  const selectedRowIds = useTrackerStore(useShallow((s) => s.selectedRowIds));
  const batchSetPipeline = useTrackerStore((s) => s.batchSetPipeline);
  const batchSetRetoucher = useTrackerStore((s) => s.batchSetRetoucher);
  const deleteRows = useTrackerStore((s) => s.deleteRows);
  const clearSelection = useTrackerStore((s) => s.clearSelection);
  const [retoucher, setRetoucher] = useState('');

  if (selectedRowIds.length === 0) return null;

  return (
    <div className="batch-bar">
      <span className="batch-count">{selectedRowIds.length} selected</span>

      <div className="batch-actions">
        {PIPELINE_STAGES.map((stage) => (
          <button key={stage} className="chip" onClick={() => batchSetPipeline(selectedRowIds, stage, true)}>
            {STAGE_LABELS[stage]}: YES
          </button>
        ))}

        <input
          className="field field-sm"
          placeholder="Retoucher initials…"
          value={retoucher}
          onChange={(e) => setRetoucher(e.target.value)}
        />
        <button
          className="btn"
          onClick={() => {
            if (!retoucher.trim()) return;
            batchSetRetoucher(selectedRowIds, retoucher.trim());
            setRetoucher('');
          }}
        >
          Assign retoucher
        </button>

        <button
          className="btn btn-danger"
          onClick={() => {
            if (confirm(`Delete ${selectedRowIds.length} selected shot(s)? Undo with Cmd+Z.`)) {
              deleteRows(selectedRowIds);
            }
          }}
        >
          Delete selected
        </button>
        <button className="btn" onClick={clearSelection}>
          Clear
        </button>
      </div>
    </div>
  );
}
