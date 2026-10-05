import {
  LONGSHOT_EXEMPT_STAGES,
  PIPELINE_STAGES,
  ROW_FIELD_PATHS,
  STAGE_LABELS,
  SIDE_LABELS,
  type PipelineStage,
  type ShotComment,
  type ShotRow,
  type Side,
  type TrackerDocument,
} from './schema';

/**
 * Pure read-only logic over a document — the one place that defines what
 * "complete", "waiting on", and "needs attention" mean, so the overview, the
 * grid, the inspector and the printed sheet can never disagree.
 */

export type { Side };

/** Which side(s) of a row are live, per its usage. */
export function activeSides(row: ShotRow): Side[] {
  if (row.usage === 'mag') return ['mag'];
  if (row.usage === 'pr') return ['pr'];
  if (row.usage === 'both') return ['mag', 'pr'];
  return [];
}

/** Stages that apply to this shot. A longshot skips assembled/submitted/approved. */
export function applicableStages(row: ShotRow): PipelineStage[] {
  if (row.shotType !== 'longshot') return [...PIPELINE_STAGES];
  return PIPELINE_STAGES.filter((s) => !LONGSHOT_EXEMPT_STAGES.includes(s));
}

export function isSideComplete(row: ShotRow, side: Side): boolean {
  return applicableStages(row).every((stage) => row[side].pipeline[stage]);
}

/** Complete when every applicable stage is done on every active property. */
export function isRowComplete(row: ShotRow): boolean {
  const sides = activeSides(row);
  return sides.length > 0 && sides.every((side) => isSideComplete(row, side));
}

/** The first applicable stage not yet done on this property — what it's waiting on. */
export function nextStage(row: ShotRow, side: Side): PipelineStage | null {
  return applicableStages(row).find((stage) => !row[side].pipeline[stage]) ?? null;
}

/** Plain-language status for one property: "Waiting on QC", "Complete". */
export function sideStatusLabel(row: ShotRow, side: Side): string {
  const next = nextStage(row, side);
  return next ? `Waiting on ${STAGE_LABELS[next]}` : 'Complete';
}

/** How many applicable stages are done, for a small progress bar. */
export function sideProgress(row: ShotRow, side: Side): { done: number; total: number } {
  const stages = applicableStages(row);
  return { done: stages.filter((s) => row[side].pipeline[s]).length, total: stages.length };
}

/** Retouched but not yet QC'd — the bottleneck worth flagging. */
export function isStalled(row: ShotRow, side: Side): boolean {
  return row[side].pipeline.retouched && !row[side].pipeline.qc;
}

/* ------------------------------------------------------------------ *
 * Comments
 * ------------------------------------------------------------------ */

/** Top-level comments, oldest first, each with its replies. */
export function commentThreads(row: ShotRow): Array<{ comment: ShotComment; replies: ShotComment[] }> {
  const all = Object.values(row.comments).sort((a, b) => a.at - b.at);
  const tops = all.filter((c) => !c.replyTo || !row.comments[c.replyTo]);
  return tops.map((comment) => ({ comment, replies: all.filter((c) => c.replyTo === comment.id) }));
}

/** Concerns still waiting on someone. */
export function openConcerns(row: ShotRow): ShotComment[] {
  return Object.values(row.comments).filter((c) => c.kind === 'concern' && !c.replyTo && !c.resolved);
}

/* ------------------------------------------------------------------ *
 * Dashboard numbers
 * ------------------------------------------------------------------ */

export interface StageCount {
  done: number;
  eligible: number;
}

export interface SideStats {
  shots: number;
  complete: number;
  stalled: number;
  stages: Record<PipelineStage, StageCount>;
  /** How many shots are currently waiting on each stage. */
  waiting: Record<PipelineStage, number>;
}

export interface DocStats {
  total: number;
  complete: number;
  shared: number;
  unassignedUsage: number;
  openConcerns: number;
  sides: Record<Side, SideStats>;
}

function emptySideStats(): SideStats {
  const stages = {} as Record<PipelineStage, StageCount>;
  const waiting = {} as Record<PipelineStage, number>;
  for (const s of PIPELINE_STAGES) {
    stages[s] = { done: 0, eligible: 0 };
    waiting[s] = 0;
  }
  return { shots: 0, complete: 0, stalled: 0, stages, waiting };
}

export function computeStats(doc: TrackerDocument): DocStats {
  const stats: DocStats = {
    total: 0,
    complete: 0,
    shared: 0,
    unassignedUsage: 0,
    openConcerns: 0,
    sides: { mag: emptySideStats(), pr: emptySideStats() },
  };

  for (const id of doc.rowIds) {
    const row = doc.rows[id];
    if (!row) continue;
    stats.total++;
    if (row.usage === 'both') stats.shared++;
    if (row.usage === 'none') stats.unassignedUsage++;
    stats.openConcerns += openConcerns(row).length;
    if (isRowComplete(row)) stats.complete++;

    const applicable = applicableStages(row);
    for (const side of activeSides(row)) {
      const s = stats.sides[side];
      s.shots++;
      for (const stage of applicable) {
        s.stages[stage].eligible++;
        if (row[side].pipeline[stage]) s.stages[stage].done++;
      }
      const next = nextStage(row, side);
      if (next) s.waiting[next]++;
      else s.complete++;
      if (isStalled(row, side)) s.stalled++;
    }
  }
  return stats;
}

/** Something on a shot that someone should act on. */
export interface AttentionItem {
  rowId: string;
  kind: 'concern' | 'stalled' | 'no-usage' | 'no-retoucher';
  side: Side | null;
  text: string;
  /** For sorting: concerns first, then oldest. */
  at: number;
}

export function attentionItems(doc: TrackerDocument): AttentionItem[] {
  const items: AttentionItem[] = [];
  for (const id of doc.rowIds) {
    const row = doc.rows[id];
    if (!row) continue;
    for (const c of openConcerns(row)) {
      items.push({ rowId: id, kind: 'concern', side: c.side, text: `${c.author || 'Someone'}: ${c.text}`, at: c.at });
    }
    if (row.usage === 'none') {
      items.push({ rowId: id, kind: 'no-usage', side: null, text: 'Not assigned to magazine or press release', at: 0 });
    }
    for (const side of activeSides(row)) {
      if (isStalled(row, side)) {
        items.push({ rowId: id, kind: 'stalled', side, text: `${SIDE_LABELS[side]}: retouched, waiting on QC`, at: 0 });
      }
      if (!row[side].retoucher.trim() && nextStage(row, side) === 'retouched') {
        items.push({ rowId: id, kind: 'no-retoucher', side, text: `${SIDE_LABELS[side]}: no retoucher assigned`, at: 0 });
      }
    }
  }
  const order = { concern: 0, stalled: 1, 'no-retoucher': 2, 'no-usage': 3 };
  return items.sort((a, b) => order[a.kind] - order[b.kind] || a.at - b.at);
}

export interface Workload {
  retoucher: string;
  assigned: number;
  remaining: number;
}

/** Per retoucher: placements assigned, and how many still aren't retouched. */
export function retoucherWorkload(doc: TrackerDocument): Workload[] {
  const map = new Map<string, Workload>();
  for (const id of doc.rowIds) {
    const row = doc.rows[id];
    if (!row) continue;
    for (const side of activeSides(row)) {
      const name = row[side].retoucher.trim();
      if (!name) continue;
      const key = name.toUpperCase();
      const w = map.get(key) ?? { retoucher: name, assigned: 0, remaining: 0 };
      w.assigned++;
      if (!row[side].pipeline.retouched) w.remaining++;
      map.set(key, w);
    }
  }
  return [...map.values()].sort((a, b) => b.remaining - a.remaining || a.retoucher.localeCompare(b.retoucher));
}

export interface ActivityEntry {
  rowId: string;
  at: number;
  who: string;
  text: string;
}

const FIELD_LABELS: Partial<Record<string, string>> = {
  shotNum: 'shot number',
  shotType: 'shot type',
  usage: 'usage',
  notes: 'description',
  imageHash: 'photo',
};

/**
 * The most recent change to each field, newest first — what each person last
 * did, derived from the edit stamps rather than a separate log, so it is
 * exactly as current as the data and travels between sites with it.
 */
export function recentActivity(doc: TrackerDocument, limit = 25): ActivityEntry[] {
  const entries: ActivityEntry[] = [];
  for (const id of doc.rowIds) {
    const row = doc.rows[id];
    if (!row) continue;
    const shot = row.shotNum || row.elvisName || 'a shot';
    for (const path of ROW_FIELD_PATHS) {
      const stamp = row.fieldTimes[path];
      if (!stamp || !stamp.u) continue;
      const m = /^(mag|pr)\.pipeline\.(\w+)$/.exec(path);
      let text: string;
      if (m) {
        const side = m[1] as Side;
        const stage = m[2] as PipelineStage;
        text = `${row[side].pipeline[stage] ? 'marked' : 'unmarked'} ${STAGE_LABELS[stage]} on ${shot} (${side === 'mag' ? 'Mag' : 'PR'})`;
      } else if (/^(mag|pr)\.retoucher$/.test(path)) {
        const side = path.slice(0, path.indexOf('.')) as Side;
        text = `assigned ${row[side].retoucher || 'no one'} to retouch ${shot} (${side === 'mag' ? 'Mag' : 'PR'})`;
      } else if (path === 'elvisAssetId') {
        text = row.elvisAssetId ? `linked ${shot} to ${row.elvisName || 'its asset'} in Elvis` : `unlinked ${shot} from Elvis`;
      } else if (path === 'imageHash' && stamp.d === 'elvis') {
        text = `has a new version of ${shot}`;
      } else if (FIELD_LABELS[path]) {
        text = `changed the ${FIELD_LABELS[path]} of ${shot}`;
      } else continue;
      entries.push({ rowId: id, at: stamp.t, who: stamp.u, text });
    }
    for (const c of Object.values(row.comments)) {
      entries.push({
        rowId: id,
        at: c.at,
        who: c.author,
        text: `${c.replyTo ? 'replied on' : c.kind === 'concern' ? 'raised a concern on' : 'commented on'} ${shot}`,
      });
      if (c.resolvedAt && c.resolvedBy) {
        entries.push({ rowId: id, at: c.resolvedAt, who: c.resolvedBy, text: `${c.resolved ? 'resolved' : 'reopened'} a concern on ${shot}` });
      }
    }
  }
  return entries.sort((a, b) => b.at - a.at).slice(0, limit);
}

/* ------------------------------------------------------------------ *
 * Filters
 * ------------------------------------------------------------------ */

export interface Filters {
  property: 'all' | 'mag' | 'pr' | 'both' | 'none';
  shotType: 'all' | 'longshot' | 'closeup' | 'unassigned';
  select: 'all' | 'main' | 'alt';
  /** Show only shots waiting on this stage (on whichever property is filtered). */
  waitingOn: 'all' | PipelineStage | 'complete';
  attention: 'all' | 'concerns' | 'any';
  search: string;
}

export const defaultFilters: Filters = {
  property: 'all',
  shotType: 'all',
  select: 'all',
  waitingOn: 'all',
  attention: 'all',
  search: '',
};

export function filtersActive(f: Filters): boolean {
  return (Object.keys(defaultFilters) as Array<keyof Filters>).some((k) => f[k] !== defaultFilters[k]);
}

export function matchesFilters(row: ShotRow, f: Filters): boolean {
  if (f.property !== 'all') {
    if (f.property === 'mag' && row.usage !== 'mag' && row.usage !== 'both') return false;
    if (f.property === 'pr' && row.usage !== 'pr' && row.usage !== 'both') return false;
    if ((f.property === 'both' || f.property === 'none') && row.usage !== f.property) return false;
  }
  if (f.shotType !== 'all' && row.shotType !== f.shotType) return false;

  // Stage and select filters look at the property being filtered on, or at
  // any live property when none is chosen.
  const sides = f.property === 'mag' || f.property === 'pr' ? [f.property] : activeSides(row);

  if (f.select !== 'all' && !sides.some((side) => row[side].selectType === f.select)) return false;

  if (f.waitingOn !== 'all') {
    if (sides.length === 0) return false;
    const match =
      f.waitingOn === 'complete'
        ? sides.every((side) => nextStage(row, side) === null)
        : sides.some((side) => nextStage(row, side) === f.waitingOn);
    if (!match) return false;
  }

  if (f.attention === 'concerns' && openConcerns(row).length === 0) return false;
  if (f.attention === 'any') {
    const flagged =
      openConcerns(row).length > 0 ||
      row.usage === 'none' ||
      activeSides(row).some((side) => isStalled(row, side) || (!row[side].retoucher.trim() && !row[side].pipeline.retouched));
    if (!flagged) return false;
  }

  if (f.search.trim()) {
    const needle = f.search.trim().toLowerCase();
    const haystack = [
      row.shotNum,
      row.elvisName,
      row.elvisPath,
      row.mag.retoucher,
      row.pr.retoucher,
      row.mag.position,
      row.pr.position,
      row.notes,
      ...Object.values(row.comments).map((c) => c.text),
    ]
      .join(' ')
      .toLowerCase();
    if (!haystack.includes(needle)) return false;
  }
  return true;
}
