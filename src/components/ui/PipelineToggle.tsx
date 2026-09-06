import type { PipelineStage } from '@/state/schema';

const STAGE_LABELS: Record<PipelineStage, string> = {
  retouched: 'Retouched',
  qc: 'QC OK',
  assembled: 'Assembled',
  submitted: 'Submitted',
  approved: 'Approved',
};

export function PipelineToggle({
  stage,
  done,
  applicable,
  compact = false,
  onToggle,
}: {
  stage: PipelineStage;
  done: boolean;
  applicable: boolean;
  compact?: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      className={`pipeline-toggle ${done ? 'pipeline-toggle-yes' : ''} ${compact ? 'pipeline-toggle-compact' : ''}`}
      disabled={!applicable}
      title={applicable ? STAGE_LABELS[stage] : 'Not applicable to a longshot'}
      onClick={onToggle}
    >
      {compact ? (done ? 'YES' : 'NO') : STAGE_LABELS[stage]}
    </button>
  );
}
