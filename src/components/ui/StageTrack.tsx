import type { CSSProperties } from 'react';
import { applicableStages, nextStage } from '@/state/selectors';
import { propertyStyle } from '@/state/properties';
import { STAGE_LABELS, trackOf, type PropertyDef, type ShotRow } from '@/state/schema';

/**
 * One property's progress at a glance: a dot per stage that applies (a
 * longshot shows three, not five) and what it's waiting on. Read-only — the
 * inspector and the sheet are where stages are changed.
 */
export function StageTrack({ row, prop, compact = false }: { row: ShotRow; prop: PropertyDef; compact?: boolean }) {
  const stages = applicableStages(row);
  const next = nextStage(row, prop.id);
  const pipeline = trackOf(row, prop.id).pipeline;
  return (
    <div className={`track ${compact ? 'track-compact' : ''}`} style={propertyStyle(prop.color) as CSSProperties}>
      <span className="track-label" title={prop.name}>
        {prop.short}
      </span>
      <span className="track-dots" aria-hidden>
        {stages.map((stage) => (
          <span
            key={stage}
            className={`track-dot ${pipeline[stage] ? 'track-dot-done' : ''} ${stage === next ? 'track-dot-next' : ''}`}
            title={`${STAGE_LABELS[stage]}: ${pipeline[stage] ? 'done' : 'not done'}`}
          />
        ))}
      </span>
      {!compact && <span className={`track-status ${next ? '' : 'track-status-complete'}`}>{next ? STAGE_LABELS[next] : 'Complete'}</span>}
    </div>
  );
}

/** A property's tag, in its colour. */
export function PropertyTag({ prop }: { prop: PropertyDef }) {
  return (
    <span className="track-label" style={propertyStyle(prop.color) as CSSProperties} title={prop.name}>
      {prop.short}
    </span>
  );
}
