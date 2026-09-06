import { useMemo, useState } from 'react';
import { useTrackerStore } from '@/state/useTrackerStore';
import { useShallow } from 'zustand/react/shallow';
import { matchesFilters } from '@/state/selectors';
import { TrackerRow } from './TrackerRow';
import { StatsBar } from '@/components/toolbar/StatsBar';
import { useFileImport } from '@/components/grid/useFileImport';
import { PIPELINE_STAGES } from '@/state/schema';

type SortKey = 'shotNum' | 'shotType' | 'usage' | 'magPosition' | 'prPosition' | 'magRetoucher' | null;

const COLUMN_LABELS: Record<string, string> = {
  retouched: 'Retouched',
  qc: 'QC OK',
  assembled: 'Assembled',
  submitted: 'Submitted',
  approved: 'Approved',
};

/**
 * The tabloid sheet: one row per shot, laid out for print. This is the
 * closest thing to the original tool's table, and the printable deliverable
 * — the header fields and the stats bar below print along with the table,
 * everything else in the app (toolbar, filters, inspector) carries a
 * `.no-print` class and drops out of the printed page (see print.css).
 *
 * Sort here is display-only, held in local state rather than written back
 * into `rowIds` — clicking a header to eyeball the order should not itself
 * be an edit that needs undoing, and it must not race with someone else's
 * drag-to-reorder in the grid view.
 */
export function TrackerSheet() {
  const rowIds = useTrackerStore(useShallow((s) => s.doc.rowIds));
  const filters = useTrackerStore(useShallow((s) => s.filters));
  const revision = useTrackerStore((s) => s.revision);
  const header = useTrackerStore(useShallow((s) => s.doc.header));
  const setHeader = useTrackerStore((s) => s.setHeader);
  const addRow = useTrackerStore((s) => s.addRow);
  const { importFiles } = useFileImport();
  const [sortKey, setSortKey] = useState<SortKey>(null);
  const [sortAsc, setSortAsc] = useState(true);
  const [dragOver, setDragOver] = useState(false);

  const visibleIds = useMemo(() => {
    const doc = useTrackerStore.getState().doc;
    const ids = rowIds.filter((id) => {
      const row = doc.rows[id];
      return row ? matchesFilters(row, filters) : false;
    });
    if (!sortKey) return ids;

    const valueOf = (id: string): string => {
      const row = doc.rows[id];
      if (!row) return '';
      switch (sortKey) {
        case 'shotNum': return row.shotNum;
        case 'shotType': return row.shotType;
        case 'usage': return row.usage;
        case 'magPosition': return row.mag.position;
        case 'prPosition': return row.pr.position;
        case 'magRetoucher': return row.mag.retoucher;
        default: return '';
      }
    };
    const sorted = [...ids].sort((a, b) => {
      const va = valueOf(a).trim();
      const vb = valueOf(b).trim();
      if (va === '' && vb !== '') return 1;
      if (va !== '' && vb === '') return -1;
      const numA = Number(va);
      const numB = Number(vb);
      const cmp = !isNaN(numA) && !isNaN(numB) && va !== '' && vb !== '' ? numA - numB : va.localeCompare(vb);
      return sortAsc ? cmp : -cmp;
      // eslint-disable-next-line react-hooks/exhaustive-deps
    });
    return sorted;
  }, [rowIds, filters, revision, sortKey, sortAsc]);

  function headerSort(key: SortKey) {
    if (sortKey === key) setSortAsc((a) => !a);
    else {
      setSortKey(key);
      setSortAsc(true);
    }
  }

  return (
    <div
      className="sheet-scroll"
      onDragOver={(e) => {
        e.preventDefault();
        if (e.dataTransfer.types.includes('Files')) setDragOver(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragOver(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        if (e.dataTransfer.files.length > 0) void importFiles(e.dataTransfer.files);
      }}
    >
      <div className={`sheet-page ${dragOver ? 'sheet-page-drag-over' : ''}`}>
        <div className="sheet-header">
          <div className="sheet-header-left">
            <h1>Photo Production Tracker</h1>
            <div className="sheet-header-inputs">
              <label>
                Lead <input value={header.name} placeholder="Manager / Lead…" onChange={(e) => setHeader({ name: e.target.value })} />
              </label>
              <label>
                Event <input value={header.event} placeholder="Title / Client…" onChange={(e) => setHeader({ event: e.target.value })} />
              </label>
            </div>
          </div>
          <div className="sheet-header-right">
            <label>
              Date / Time <input value={header.date} placeholder="Enter date & time" onChange={(e) => setHeader({ date: e.target.value })} />
            </label>
          </div>
        </div>

        <StatsBar />

        <div className="sheet-table-wrap">
          <table className="sheet-table">
            <thead>
              <tr>
                <th className="no-print" style={{ width: 24 }} />
                <th className="no-print" style={{ width: 24 }} />
                <th style={{ width: 90 }}>Photo</th>
                <th onClick={() => headerSort('shotNum')}>Shot #</th>
                <th onClick={() => headerSort('shotType')}>Shot Type</th>
                <th onClick={() => headerSort('usage')}>Usage</th>
                <th onClick={() => headerSort('magPosition')}>Spread / Slide #</th>
                <th>Select Type</th>
                <th onClick={() => headerSort('magRetoucher')}>Retoucher</th>
                {PIPELINE_STAGES.map((stage) => (
                  <th key={stage}>{COLUMN_LABELS[stage]}</th>
                ))}
                <th className="no-print" style={{ width: 28 }} />
              </tr>
            </thead>
            <tbody>
              {visibleIds.map((id) => (
                <TrackerRow key={id} rowId={id} />
              ))}
            </tbody>
          </table>
        </div>

        <button type="button" className="btn no-print" onClick={addRow} style={{ marginTop: 12 }}>
          + Add shot
        </button>
      </div>
      {dragOver && <div className="drop-veil no-print">Drop photos to add shots</div>}
    </div>
  );
}
