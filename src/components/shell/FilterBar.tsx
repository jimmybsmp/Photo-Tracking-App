import type { ReactNode } from 'react';
import { useTrackerStore } from '@/state/useTrackerStore';
import { useShallow } from 'zustand/react/shallow';
import { filtersActive, type Filters } from '@/state/selectors';
import { PIPELINE_STAGES, STAGE_LABELS } from '@/state/schema';

/**
 * Filters shared by the Shots grid and the Sheet. Stage and select filters
 * follow the property filter: "Magazine + waiting on QC" means shots whose
 * *magazine* track is at QC, whatever the press-release side is doing.
 */
export function FilterBar({ shown, total, children }: { shown: number; total: number; children?: ReactNode }) {
  const filters = useTrackerStore(useShallow((s) => s.filters));
  const setFilters = useTrackerStore((s) => s.setFilters);
  const resetFilters = useTrackerStore((s) => s.resetFilters);

  const select = <K extends keyof Filters>(key: K, options: Array<[Filters[K], string]>) => (
    <select
      className={`field field-select ${filters[key] !== options[0][0] ? 'field-active' : ''}`}
      value={String(filters[key])}
      onChange={(e) => setFilters({ [key]: e.target.value } as Partial<Filters>)}
    >
      {options.map(([value, label]) => (
        <option key={String(value)} value={String(value)}>
          {label}
        </option>
      ))}
    </select>
  );

  return (
    <div className="filterbar no-print">
      {select('property', [
        ['all', 'All properties'],
        ['mag', 'Magazine'],
        ['pr', 'Press release'],
        ['both', 'In both'],
        ['none', 'No usage set'],
      ])}
      {select('waitingOn', [
        ['all', 'Any stage'],
        ...PIPELINE_STAGES.map((s) => [s, `Waiting on ${STAGE_LABELS[s]}`] as [Filters['waitingOn'], string]),
        ['complete', 'Complete'],
      ])}
      {select('attention', [
        ['all', 'Everything'],
        ['concerns', 'Open concerns'],
        ['any', 'Needs attention'],
      ])}
      {select('shotType', [
        ['all', 'Any shot type'],
        ['closeup', 'Close-ups'],
        ['longshot', 'Longshots'],
        ['unassigned', 'Type not set'],
      ])}
      {select('select', [
        ['all', 'Main & alt'],
        ['main', 'Main selects'],
        ['alt', 'Alt shots'],
      ])}
      <input
        className="field filter-search"
        placeholder="Search shot #, file, retoucher, comments…"
        value={filters.search}
        onChange={(e) => setFilters({ search: e.target.value })}
      />
      {filtersActive(filters) && (
        <button className="btn btn-ghost" onClick={resetFilters}>
          Clear filters
        </button>
      )}
      <span className="filter-count">{shown === total ? `${total} shots` : `${shown} of ${total} shots`}</span>
      {children}
    </div>
  );
}
