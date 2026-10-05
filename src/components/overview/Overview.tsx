import { useMemo } from 'react';
import { useTrackerStore } from '@/state/useTrackerStore';
import {
  attentionItems,
  computeStats,
  defaultFilters,
  recentActivity,
  retoucherWorkload,
  type AttentionItem,
  type SideStats,
} from '@/state/selectors';
import { PIPELINE_STAGES, SIDE_LABELS, STAGE_LABELS, type PipelineStage, type Side, type TrackerDocument } from '@/state/schema';
import { useSyncStore } from '@/lib/elvis/autoSync';
import { pct, timeAgo } from '@/lib/format';
import { StageTrack } from '@/components/ui/StageTrack';
import { useNow } from '@/components/ui/hooks';

/**
 * The executive view: where the whole shoot stands, per property, and what
 * needs someone's attention right now. Every number is a way in — clicking
 * a stage, a shot, or a concern opens exactly those shots.
 */
export function Overview({ onImport }: { onImport: () => void }) {
  const doc = useTrackerStore((s) => s.doc);
  const setFilters = useTrackerStore((s) => s.setFilters);
  const setView = useTrackerStore((s) => s.setView);
  const openRow = useTrackerStore((s) => s.openRow);
  const now = useNow(30_000);

  const stats = useMemo(() => computeStats(doc), [doc]);
  const attention = useMemo(() => attentionItems(doc), [doc]);
  const workload = useMemo(() => retoucherWorkload(doc), [doc]);
  const activity = useMemo(() => recentActivity(doc, 14), [doc]);
  const shared = useMemo(() => doc.rowIds.filter((id) => doc.rows[id]?.usage === 'both'), [doc]);

  const showShots = (patch: Partial<typeof defaultFilters>) => {
    setFilters({ ...defaultFilters, ...patch });
    setView('shots');
  };

  if (stats.total === 0) {
    return (
      <div className="overview overview-empty">
        <h1>No shots yet</h1>
        <p className="muted">
          Drop photos onto the Shots tab, open a project, or connect to WoodWing Elvis to pull in a shoot.
        </p>
        <div className="row-gap">
          <button className="btn btn-primary" onClick={onImport}>
            Add photos…
          </button>
          <button className="btn" onClick={() => setView('shots')}>
            Go to Shots
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="overview">
      <SyncLine />

      <section className="kpis">
        <Kpi label="Shots" value={stats.total} onClick={() => showShots({})} />
        <Kpi label="Complete" value={`${stats.complete}`} sub={`${pct(stats.complete, stats.total)}%`} tone="good" onClick={() => showShots({ waitingOn: 'complete' })} />
        <Kpi label="Open concerns" value={stats.openConcerns} tone={stats.openConcerns ? 'warn' : undefined} onClick={() => showShots({ attention: 'concerns' })} />
        <Kpi label="In both properties" value={stats.shared} onClick={() => showShots({ property: 'both' })} />
        <Kpi label="No usage set" value={stats.unassignedUsage} tone={stats.unassignedUsage ? 'warn' : undefined} onClick={() => showShots({ property: 'none' })} />
      </section>

      <section className="property-cards">
        {(['mag', 'pr'] as Side[]).map((side) => (
          <PropertyCard key={side} side={side} stats={stats.sides[side]} onStage={(stage) => showShots({ property: side, waitingOn: stage })} onAll={() => showShots({ property: side })} />
        ))}
      </section>

      <div className="overview-columns">
        <section className="panel">
          <h2>
            Needs attention <span className="count">{attention.length}</span>
          </h2>
          {attention.length === 0 ? (
            <p className="muted">Nothing waiting on anyone.</p>
          ) : (
            <ul className="attention-list">
              {attention.slice(0, 40).map((item, i) => (
                <AttentionRow key={`${item.rowId}-${item.kind}-${i}`} item={item} doc={doc} onOpen={() => openRow(item.rowId)} />
              ))}
            </ul>
          )}
        </section>

        <section className="panel">
          <h2>
            Shared between magazine &amp; press release <span className="count">{shared.length}</span>
          </h2>
          {shared.length === 0 ? (
            <p className="muted">No shot is set to run in both yet.</p>
          ) : (
            <table className="shared-table">
              <tbody>
                {shared.slice(0, 40).map((id) => {
                  const row = doc.rows[id];
                  return (
                    <tr key={id} onClick={() => openRow(id)}>
                      <td className="shared-thumb">
                        <Thumb doc={doc} hash={row.imageHash} />
                      </td>
                      <td className="shared-name">{row.shotNum || row.elvisName || '—'}</td>
                      <td>
                        <StageTrack row={row} side="mag" />
                      </td>
                      <td>
                        <StageTrack row={row} side="pr" />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </section>
      </div>

      <div className="overview-columns">
        <section className="panel">
          <h2>Retouching workload</h2>
          {workload.length === 0 ? (
            <p className="muted">No retouchers assigned yet.</p>
          ) : (
            <ul className="workload">
              {workload.map((w) => (
                <li key={w.retoucher} onClick={() => showShots({ search: w.retoucher })}>
                  <span className="workload-name">{w.retoucher}</span>
                  <span className="bar">
                    <span className="bar-fill" style={{ width: `${pct(w.assigned - w.remaining, w.assigned)}%` }} />
                  </span>
                  <span className="workload-count">
                    {w.remaining} to do / {w.assigned}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="panel">
          <h2>Recent activity</h2>
          {activity.length === 0 ? (
            <p className="muted">Changes appear here with who made them.</p>
          ) : (
            <ul className="activity">
              {activity.map((a, i) => (
                <li key={i} onClick={() => openRow(a.rowId)}>
                  <strong>{a.who}</strong> {a.text}
                  <span className="muted small"> · {timeAgo(a.at, now)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}

function SyncLine() {
  const status = useSyncStore((s) => s.status);
  const lastSyncAt = useSyncStore((s) => s.lastSyncAt);
  const shared = useTrackerStore((s) => Boolean(s.doc.elvisFile));
  const header = useTrackerStore((s) => s.doc.header);
  const setHeader = useTrackerStore((s) => s.setHeader);
  useNow(20_000);
  const syncText =
    status === 'idle' && lastSyncAt
      ? `${shared ? 'Shared through Elvis' : 'Elvis pictures current'} · synced ${timeAgo(lastSyncAt)}`
      : status === 'syncing'
        ? 'Syncing with Elvis…'
        : status === 'error'
          ? 'Not synced with Elvis — changes are kept here and sent when the connection returns'
          : '';
  return (
    <div className="sync-line">
      <input
        className="title-input"
        value={header.event}
        placeholder="Name this shoot"
        onChange={(e) => setHeader({ event: e.target.value })}
        aria-label="Shoot name"
      />
      <span className="muted">
        {[header.date, header.name && `Lead: ${header.name}`].filter(Boolean).join(' · ')}
      </span>
      {syncText && <span className={`sync-line-status ${status === 'error' ? 'bad' : ''}`}>{syncText}</span>}
    </div>
  );
}

function Kpi({ label, value, sub, tone, onClick }: { label: string; value: number | string; sub?: string; tone?: 'good' | 'warn'; onClick: () => void }) {
  return (
    <button className={`kpi ${tone ? `kpi-${tone}` : ''}`} onClick={onClick}>
      <span className="kpi-value">
        {value}
        {sub && <span className="kpi-sub"> {sub}</span>}
      </span>
      <span className="kpi-label">{label}</span>
    </button>
  );
}

function PropertyCard({
  side,
  stats,
  onStage,
  onAll,
}: {
  side: Side;
  stats: SideStats;
  onStage: (stage: PipelineStage) => void;
  onAll: () => void;
}) {
  const percent = pct(stats.complete, stats.shots);
  return (
    <div className={`property-card property-${side}`}>
      <button className="property-head" onClick={onAll}>
        <span className="property-name">{SIDE_LABELS[side]}</span>
        <span className="property-percent">{stats.shots ? `${percent}%` : '—'}</span>
      </button>
      <div className="bar bar-lg">
        <span className="bar-fill" style={{ width: `${percent}%` }} />
      </div>
      <p className="muted small">
        {stats.complete} of {stats.shots} shots complete
        {stats.stalled ? ` · ${stats.stalled} retouched, waiting on QC` : ''}
      </p>
      <ul className="stage-funnel">
        {PIPELINE_STAGES.map((stage) => {
          const c = stats.stages[stage];
          const waiting = stats.waiting[stage];
          return (
            <li key={stage} onClick={() => onStage(stage)} title={`Show ${SIDE_LABELS[side].toLowerCase()} shots waiting on ${STAGE_LABELS[stage]}`}>
              <span className="funnel-name">{STAGE_LABELS[stage]}</span>
              <span className="bar">
                <span className="bar-fill" style={{ width: `${pct(c.done, c.eligible)}%` }} />
              </span>
              <span className="funnel-count">
                {c.done}/{c.eligible}
              </span>
              <span className={`funnel-waiting ${waiting ? '' : 'muted'}`}>{waiting ? `${waiting} waiting` : ''}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

const KIND_LABEL: Record<AttentionItem['kind'], string> = {
  concern: 'Concern',
  stalled: 'Stalled',
  'no-usage': 'No usage',
  'no-retoucher': 'Unassigned',
};

function AttentionRow({ item, doc, onOpen }: { item: AttentionItem; doc: TrackerDocument; onOpen: () => void }) {
  const row = doc.rows[item.rowId];
  return (
    <li className={`attention attention-${item.kind}`} onClick={onOpen}>
      <Thumb doc={doc} hash={row?.imageHash ?? null} />
      <div className="attention-body">
        <span className="attention-shot">
          {row?.shotNum || row?.elvisName || 'Shot'}
          <span className={`kind-badge kind-${item.kind}`}>{KIND_LABEL[item.kind]}</span>
        </span>
        <span className="attention-text">{item.text}</span>
      </div>
    </li>
  );
}

function Thumb({ doc, hash }: { doc: TrackerDocument; hash: string | null }) {
  const url = hash ? doc.assets[hash]?.thumbUrl : undefined;
  return url ? <img className="mini-thumb" src={url} alt="" /> : <span className="mini-thumb mini-thumb-empty" />;
}
