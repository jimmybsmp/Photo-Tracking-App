import { applicableStages, nextStage } from '@/state/selectors';
import { STAGE_LABELS, type ShotRow, type Side } from '@/state/schema';

const SHORT: Record<Side, string> = { mag: 'MAG', pr: 'PR' };

/**
 * One property's progress at a glance: a dot per stage that applies (a
 * longshot shows three, not five) and what it's waiting on. Read-only — the
 * inspector and the sheet are where stages are changed.
 */
export function StageTrack({ row, side, compact = false }: { row: ShotRow; side: Side; compact?: boolean }) {
  const stages = applicableStages(row);
  const next = nextStage(row, side);
  return (
    <div className={`track track-${side} ${compact ? 'track-compact' : ''}`}>
      <span className={`track-label track-label-${side}`}>{SHORT[side]}</span>
      <span className="track-dots" aria-hidden>
        {stages.map((stage) => (
          <span
            key={stage}
            className={`track-dot ${row[side].pipeline[stage] ? 'track-dot-done' : ''} ${stage === next ? 'track-dot-next' : ''}`}
            title={`${STAGE_LABELS[stage]}: ${row[side].pipeline[stage] ? 'done' : 'not done'}`}
          />
        ))}
      </span>
      {!compact && (
        <span className={`track-status ${next ? '' : 'track-status-complete'}`}>
          {next ? STAGE_LABELS[next] : 'Complete'}
        </span>
      )}
    </div>
  );
}
