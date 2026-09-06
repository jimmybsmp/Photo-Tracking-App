import {
  LONGSHOT_EXEMPT_STAGES,
  PIPELINE_STAGES,
  type PipelineStage,
  type ShotRow,
  type TrackerDocument,
} from './schema';

/**
 * Pure read-only logic over a document. Kept apart from the store so the
 * print sheet, the grid, and the stats bar all agree on what "complete"
 * means without three copies of the same rules.
 *
 * Two bugs in the tool this replaces lived exactly here: a longshot's
 * assembled/submitted/approved toggles were force-reset on every load, which
 * then made `applicableStages` below the fix — a longshot simply never has
 * those three stages, so they are excluded from both the eligible count and
 * the completion check rather than being present-but-always-off.
 */

export type Side = 'mag' | 'pr';

/** Which side(s) of a row are live, per its usage. */
export function activeSides(row: ShotRow): Side[] {
  if (row.usage === 'mag') return ['mag'];
  if (row.usage === 'pr') return ['pr'];
  if (row.usage === 'both') return ['mag', 'pr'];
  return [];
}

/** Which pipeline stages apply to this row's shot type. */
export function applicableStages(row: ShotRow): PipelineStage[] {
  if (row.shotType !== 'longshot') return [...PIPELINE_STAGES];
  return PIPELINE_STAGES.filter((s) => !LONGSHOT_EXEMPT_STAGES.includes(s));
}

/** A row is complete when every applicable stage is done on every active side. */
export function isRowComplete(row: ShotRow): boolean {
  const sides = activeSides(row);
  if (sides.length === 0) return false;
  const stages = applicableStages(row);
  return sides.every((side) => stages.every((stage) => row[side].pipeline[stage]));
}

/** Retouched but not yet QC'd — the bottleneck the dashboard flags. */
export function isStalled(row: ShotRow, side: Side): boolean {
  return row[side].pipeline.retouched && !row[side].pipeline.qc;
}

export interface StageCount {
  done: number;
  eligible: number;
}

export interface DocStats {
  total: number;
  complete: number;
  stalled: number;
  stages: Record<PipelineStage, StageCount>;
}

export function computeStats(doc: TrackerDocument): DocStats {
  const stages: Record<PipelineStage, StageCount> = {
    retouched: { done: 0, eligible: 0 },
    qc: { done: 0, eligible: 0 },
    assembled: { done: 0, eligible: 0 },
    submitted: { done: 0, eligible: 0 },
    approved: { done: 0, eligible: 0 },
  };

  let complete = 0;
  let stalled = 0;

  for (const id of doc.rowIds) {
    const row = doc.rows[id];
    if (!row) continue;
    const sides = activeSides(row);
    const applicable = applicableStages(row);

    for (const side of sides) {
      for (const stage of applicable) {
        stages[stage].eligible++;
        if (row[side].pipeline[stage]) stages[stage].done++;
      }
      if (isStalled(row, side)) stalled++;
    }
    if (isRowComplete(row)) complete++;
  }

  return { total: doc.rowIds.length, complete, stalled, stages };
}

/** True if a row matches the grid/sheet filter bar's current settings. */
export function matchesFilters(
  row: ShotRow,
  filters: { usage: string; shotType: string; select: string; search: string },
): boolean {
  if (filters.usage !== 'all') {
    const isMag = row.usage === 'mag' || row.usage === 'both';
    const isPr = row.usage === 'pr' || row.usage === 'both';
    if (filters.usage === 'mag' && !isMag) return false;
    if (filters.usage === 'pr' && !isPr) return false;
    if (filters.usage === 'both' && row.usage !== 'both') return false;
    if (filters.usage === 'none' && row.usage !== 'none') return false;
  }

  if (filters.shotType !== 'all' && row.shotType !== filters.shotType) return false;

  if (filters.select !== 'all') {
    const sides = activeSides(row);
    const matches = sides.some((side) => row[side].selectType === filters.select);
    if (!matches) return false;
  }

  if (filters.search.trim()) {
    const needle = filters.search.trim().toLowerCase();
    const haystack = [row.shotNum, row.mag.retoucher, row.pr.retoucher, row.notes].join(' ').toLowerCase();
    if (!haystack.includes(needle)) return false;
  }

  return true;
}
