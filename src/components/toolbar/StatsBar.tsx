import { useTrackerStore } from '@/state/useTrackerStore';
import { computeStats } from '@/state/selectors';
import { PIPELINE_STAGES } from '@/state/schema';

const LABELS: Record<string, string> = {
  retouched: 'Retouched',
  qc: 'QC OK',
  assembled: 'Assembled',
  submitted: 'Submitted',
  approved: 'Approved',
};

/** The production dashboard: where each pipeline stage stands right now. */
export function StatsBar() {
  // Subscribing to the primitive `revision` (rather than the whole `doc`)
  // means this only re-renders when something actually changed, and then
  // reads the current document fresh — cheap, since computeStats is a
  // single pass over rows that number in the hundreds at most.
  useTrackerStore((s) => s.revision);
  const stats = computeStats(useTrackerStore.getState().doc);

  return (
    <div className="stats-bar">
      <Stat label="Total Shots" value={String(stats.total)} />
      {PIPELINE_STAGES.map((stage) => (
        <Stat key={stage} label={LABELS[stage]} value={`${stats.stages[stage].done}/${stats.stages[stage].eligible}`} />
      ))}
      <Stat label="Stalled" value={String(stats.stalled)} warn={stats.stalled > 0} />
      <Stat label="Complete" value={String(stats.complete)} good />
    </div>
  );
}

function Stat({ label, value, warn, good }: { label: string; value: string; warn?: boolean; good?: boolean }) {
  return (
    <div className="stat-card">
      <span className="stat-label">{label}</span>
      <span className={`stat-value ${warn ? 'stat-value-warn' : ''} ${good ? 'stat-value-good' : ''}`}>{value}</span>
    </div>
  );
}
