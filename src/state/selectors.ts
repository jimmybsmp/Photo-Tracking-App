import {
  LONGSHOT_EXEMPT_STAGES,
  PIPELINE_STAGES,
  STAGE_LABELS,
  parseFieldPath,
  rowFieldPaths,
  trackOf,
  type PipelineStage,
  type PropertyDef,
  type ShotComment,
  type ShotRow,
  type Side,
  type TrackerDocument,
} from './schema';
import { propertyList } from './properties';

/**
 * Pure read-only logic over a document — the one place that defines what
 * "complete", "waiting on", and "needs attention" mean, so the overview, the
 * grid, the inspector and the printed sheet can never disagree.
 */

export type { Side };

/** The properties a shot runs in, in the project's order. Hidden properties don't count. */
export function activeSides(row: ShotRow, properties: PropertyDef[]): Side[] {
  return properties.filter((p) => row.tracks[p.id]?.on).map((p) => p.id);
}

/** Runs in more than one property — the crossovers to keep in step. */
export const isShared = (row: ShotRow, properties: PropertyDef[]) => activeSides(row, properties).length > 1;

/** Stages that apply to this shot. A longshot skips assembled/submitted/approved. */
export function applicableStages(row: ShotRow): PipelineStage[] {
  if (row.shotType !== 'longshot') return [...PIPELINE_STAGES];
  return PIPELINE_STAGES.filter((s) => !LONGSHOT_EXEMPT_STAGES.includes(s));
}

export function isSideComplete(row: ShotRow, side: Side): boolean {
  return applicableStages(row).every((stage) => trackOf(row, side).pipeline[stage]);
}

/** Complete when every applicable stage is done on every active property. */
export function isRowComplete(row: ShotRow, properties: PropertyDef[]): boolean {
  const sides = activeSides(row, properties);
  return sides.length > 0 && sides.every((side) => isSideComplete(row, side));
}

/** The first applicable stage not yet done on this property — what it's waiting on. */
export function nextStage(row: ShotRow, side: Side): PipelineStage | null {
  return applicableStages(row).find((stage) => !trackOf(row, side).pipeline[stage]) ?? null;
}

/** Plain-language status for one property: "Waiting on QC", "Complete". */
export function sideStatusLabel(row: ShotRow, side: Side): string {
  const next = nextStage(row, side);
  return next ? `Waiting on ${STAGE_LABELS[next]}` : 'Complete';
}

/** How many applicable stages are done, for a small progress bar. */
export function sideProgress(row: ShotRow, side: Side): { done: number; total: number } {
  const stages = applicableStages(row);
  return { done: stages.filter((s) => trackOf(row, side).pipeline[s]).length, total: stages.length };
}

/** Retouched but not yet QC'd — the bottleneck worth flagging. */
export function isStalled(row: ShotRow, side: Side): boolean {
  const t = trackOf(row, side);
  return t.pipeline.retouched && !t.pipeline.qc;
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
  /** Shots running in more than one property. */
  shared: number;
  unassignedUsage: number;
  openConcerns: number;
  /** Per property id, for every property in use. */
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
  const properties = propertyList(doc.properties);
  const stats: DocStats = {
    total: 0,
    complete: 0,
    shared: 0,
    unassignedUsage: 0,
    openConcerns: 0,
    sides: Object.fromEntries(properties.map((p) => [p.id, emptySideStats()])),
  };

  for (const id of doc.rowIds) {
    const row = doc.rows[id];
    if (!row) continue;
    stats.total++;
    const sides = activeSides(row, properties);
    if (sides.length > 1) stats.shared++;
    if (sides.length === 0) stats.unassignedUsage++;
    stats.openConcerns += openConcerns(row).length;
    if (isRowComplete(row, properties)) stats.complete++;

    const applicable = applicableStages(row);
    for (const side of sides) {
      const s = stats.sides[side];
      const track = trackOf(row, side);
      s.shots++;
      for (const stage of applicable) {
        s.stages[stage].eligible++;
        if (track.pipeline[stage]) s.stages[stage].done++;
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
  const properties = propertyList(doc.properties);
  const items: AttentionItem[] = [];
  for (const id of doc.rowIds) {
    const row = doc.rows[id];
    if (!row) continue;
    for (const c of openConcerns(row)) {
      items.push({ rowId: id, kind: 'concern', side: c.side, text: `${c.author || 'Someone'}: ${c.text}`, at: c.at });
    }
    const sides = activeSides(row, properties);
    if (sides.length === 0) {
      items.push({ rowId: id, kind: 'no-usage', side: null, text: 'Not assigned to any property', at: 0 });
    }
    for (const side of sides) {
      const name = doc.properties[side]?.name ?? side;
      if (isStalled(row, side)) {
        items.push({ rowId: id, kind: 'stalled', side, text: `${name}: retouched, waiting on QC`, at: 0 });
      }
      if (!trackOf(row, side).retoucher.trim() && nextStage(row, side) === 'retouched') {
        items.push({ rowId: id, kind: 'no-retoucher', side, text: `${name}: no retoucher assigned`, at: 0 });
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
  const properties = propertyList(doc.properties);
  const map = new Map<string, Workload>();
  for (const id of doc.rowIds) {
    const row = doc.rows[id];
    if (!row) continue;
    for (const side of activeSides(row, properties)) {
      const name = trackOf(row, side).retoucher.trim();
      if (!name) continue;
      const key = name.toUpperCase();
      const w = map.get(key) ?? { retoucher: name, assigned: 0, remaining: 0 };
      w.assigned++;
      if (!trackOf(row, side).pipeline.retouched) w.remaining++;
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
  const nameOf = (side: Side) => doc.properties[side]?.short ?? side.toUpperCase();
  for (const id of doc.rowIds) {
    const row = doc.rows[id];
    if (!row) continue;
    const shot = row.shotNum || row.elvisName || 'a shot';
    for (const path of rowFieldPaths(row)) {
      const stamp = row.fieldTimes[path];
      if (!stamp || !stamp.u) continue;
      const parsed = parseFieldPath(path);
      if (!parsed) continue;
      const track = 'side' in parsed ? trackOf(row, parsed.side) : null;
      let text: string;
      if ('side' in parsed && track) {
        const tag = nameOf(parsed.side);
        if (parsed.field.startsWith('pipeline.')) {
          const stage = parsed.field.slice(9) as PipelineStage;
          text = `${track.pipeline[stage] ? 'marked' : 'unmarked'} ${STAGE_LABELS[stage]} on ${shot} (${tag})`;
        } else if (parsed.field === 'retoucher') {
          text = `assigned ${track.retoucher || 'no one'} to retouch ${shot} (${tag})`;
        } else if (parsed.field === 'on') {
          text = `${track.on ? 'added' : 'took'} ${shot} ${track.on ? 'to' : 'out of'} ${doc.properties[parsed.side]?.name ?? tag}`;
        } else continue;
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
  /** A property id, or every shot, shots in more than one, or shots in none. */
  property: 'all' | 'shared' | 'none' | Side;
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

const GROUP_FILTERS = ['all', 'shared', 'none'];

export function matchesFilters(row: ShotRow, f: Filters, properties: PropertyDef[]): boolean {
  const active = activeSides(row, properties);
  // A filter on a property that has since been hidden filters nothing.
  const one = !GROUP_FILTERS.includes(f.property) && properties.some((p) => p.id === f.property) ? f.property : null;
  if (one && !active.includes(one)) return false;
  if (f.property === 'shared' && active.length < 2) return false;
  if (f.property === 'none' && active.length > 0) return false;
  if (f.shotType !== 'all' && row.shotType !== f.shotType) return false;

  // Stage and select filters look at the property being filtered on, or at
  // any live property when none is chosen.
  const sides = one ? [one] : active;

  if (f.select !== 'all' && !sides.some((side) => trackOf(row, side).selectType === f.select)) return false;

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
      active.length === 0 ||
      active.some((side) => isStalled(row, side) || (!trackOf(row, side).retoucher.trim() && !trackOf(row, side).pipeline.retouched));
    if (!flagged) return false;
  }

  if (f.search.trim()) {
    const needle = f.search.trim().toLowerCase();
    const haystack = [
      row.shotNum,
      row.elvisName,
      row.elvisPath,
      row.notes,
      ...Object.values(row.tracks).flatMap((t) => [t.retoucher, t.position]),
      ...Object.values(row.comments).map((c) => c.text),
    ]
      .join(' ')
      .toLowerCase();
    if (!haystack.includes(needle)) return false;
  }
  return true;
}
