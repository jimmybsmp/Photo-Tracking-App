import { useMemo, useState } from 'react';
import { useTrackerStore } from '@/state/useTrackerStore';
import { useShallow } from 'zustand/react/shallow';
import { activeSides, computeStats, matchesFilters } from '@/state/selectors';
import { PIPELINE_STAGES, STAGE_LABELS, trackOf, type PropertyDef, type ShotRow } from '@/state/schema';
import { FilterBar } from '@/components/shell/FilterBar';
import { useProperties } from '@/components/ui/hooks';
import { pct } from '@/lib/format';
import { TrackerRow } from './TrackerRow';

type SortKey = 'order' | 'shotNum' | 'position' | 'retoucher';

/** Sort by a shot's own value, or its first property's that has one. */
const SORT_VALUE: Record<Exclude<SortKey, 'order'>, (r: ShotRow, props: PropertyDef[]) => string> = {
  shotNum: (r) => r.shotNum || r.elvisName,
  position: (r, props) => activeSides(r, props).map((side) => trackOf(r, side).position).find(Boolean) ?? '',
  retoucher: (r, props) => activeSides(r, props).map((side) => trackOf(r, side).retoucher).find(Boolean) ?? '',
};

/**
 * The tabloid sheet: one row per shot, laid out for print. The header, the
 * progress summary and the table print; everything marked `.no-print` drops
 * out (print.css). Sorting is display-only — clicking a header to look at an
 * order isn't an edit, and doesn't change the shared shot order.
 */
export function TrackerSheet() {
  const rowIds = useTrackerStore(useShallow((s) => s.doc.rowIds));
  const doc = useTrackerStore((s) => s.doc);
  const filters = useTrackerStore(useShallow((s) => s.filters));
  const header = useTrackerStore(useShallow((s) => s.doc.header));
  const setHeader = useTrackerStore((s) => s.setHeader);
  const addRow = useTrackerStore((s) => s.addRow);
  const properties = useProperties();
  const [sort, setSort] = useState<{ key: SortKey; asc: boolean }>({ key: 'order', asc: true });

  const visible = useMemo(() => {
    const ids = rowIds.filter((id) => doc.rows[id] && matchesFilters(doc.rows[id], filters, properties));
    if (sort.key === 'order') return ids;
    const value = SORT_VALUE[sort.key];
    return [...ids].sort((a, b) => {
      const va = value(doc.rows[a], properties).trim();
      const vb = value(doc.rows[b], properties).trim();
      if (!va !== !vb) return va ? -1 : 1;
      const cmp = va.localeCompare(vb, undefined, { numeric: true });
      return sort.asc ? cmp : -cmp;
    });
  }, [rowIds, doc, filters, sort, properties]);

  const stats = useMemo(() => computeStats(doc), [doc]);
  const by = (key: SortKey) => () => setSort((s) => ({ key, asc: s.key === key ? !s.asc : true }));
  const arrow = (key: SortKey) => (sort.key === key ? (sort.asc ? ' ↑' : ' ↓') : '');

  return (
    <div className="view-col">
      <FilterBar shown={visible.length} total={rowIds.length}>
        {sort.key !== 'order' && (
          <button className="btn btn-ghost" onClick={() => setSort({ key: 'order', asc: true })}>
            Original order
          </button>
        )}
        <button className="btn" onClick={addRow}>
          + Add shot
        </button>
      </FilterBar>

      <div className="sheet-scroll">
        <div className="sheet-page">
          <div className="sheet-header">
            <div className="sheet-header-main">
              <h1>Photo Production Tracker</h1>
              <div className="sheet-header-fields">
                <label>
                  Event <input value={header.event} placeholder="Title / client" onChange={(e) => setHeader({ event: e.target.value })} />
                </label>
                <label>
                  Lead <input value={header.name} placeholder="Manager / lead" onChange={(e) => setHeader({ name: e.target.value })} />
                </label>
                <label>
                  Date <input value={header.date} placeholder="Date / time" onChange={(e) => setHeader({ date: e.target.value })} />
                </label>
              </div>
            </div>
            <div className="sheet-summary">
              {properties.map((prop) => {
                const s = stats.sides[prop.id];
                return (
                  <div key={prop.id} className="sheet-summary-side">
                    <strong>{prop.name}</strong> {s.complete}/{s.shots} complete ({pct(s.complete, s.shots)}%)
                    <span className="sheet-summary-stages">
                      {PIPELINE_STAGES.map((stage) => `${STAGE_LABELS[stage]} ${s.stages[stage].done}/${s.stages[stage].eligible}`).join(' · ')}
                    </span>
                  </div>
                );
              })}
              {stats.openConcerns > 0 && <div className="sheet-summary-concerns">{stats.openConcerns} open concern(s)</div>}
            </div>
          </div>

          <table className="sheet-table">
            <thead>
              <tr>
                <th className="no-print" />
                <th className="no-print" />
                {doc.sheet.showThumbnails && <th>Photo</th>}
                <th className="sortable" onClick={by('shotNum')}>
                  Shot #{arrow('shotNum')}
                </th>
                <th>Type</th>
                <th>Runs in</th>
                <th className="sortable" onClick={by('position')}>
                  {positionHeading(properties)}
                  {arrow('position')}
                </th>
                <th>Select</th>
                <th className="sortable" onClick={by('retoucher')}>
                  Retoucher{arrow('retoucher')}
                </th>
                {PIPELINE_STAGES.map((stage) => (
                  <th key={stage}>{STAGE_LABELS[stage]}</th>
                ))}
                <th className="no-print" />
              </tr>
            </thead>
            <tbody>
              {visible.map((id) => (
                <TrackerRow key={id} rowId={id} />
              ))}
            </tbody>
          </table>
          {visible.length === 0 && <p className="muted center sheet-empty">No shots to show.</p>}
        </div>
      </div>
    </div>
  );
}

/** "Spread # / Slide #" — the position names in use, each once. */
function positionHeading(properties: PropertyDef[]): string {
  const names = [...new Set(properties.map((p) => p.positionLabel.replace(/\s*#$/, '')))];
  return names.length > 3 ? 'Position' : names.join(' / ') || 'Position';
}
