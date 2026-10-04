import { newId } from '@/lib/compat';

/**
 * Project document schema and the load-time migration path.
 *
 * The unit of work is a shot: one frame that may run in the magazine, in a
 * press release, or both. Each property is tracked on its own track — every
 * stage, retouching included — because a magazine image is printed far larger
 * than anything online and usually gets its own CMYK colour work and detail
 * retouching. `mag` and `pr` are always present on a row; `usage` decides
 * which are live and the UI hides the other, but a hidden side's data is
 * never discarded — switching usage back and forth must not lose work.
 *
 * Version 2 changes, all handled by `migrate()`:
 *   - Edit stamps carry the person's name, so every stage shows who marked it.
 *   - Each shot carries a comment thread: concerns (which stay open until
 *     someone resolves them) and notes, with replies.
 *   - Shots pulled from Elvis get a row id derived from the asset id, so every
 *     site that pulls the same asset agrees on which row it is.
 */

export const SCHEMA_VERSION = 2;

/* ------------------------------------------------------------------ *
 * Pipeline
 * ------------------------------------------------------------------ */

/** The five stages a placement moves through, in order. */
export const PIPELINE_STAGES = ['retouched', 'qc', 'assembled', 'submitted', 'approved'] as const;
export type PipelineStage = (typeof PIPELINE_STAGES)[number];

export const STAGE_LABELS: Record<PipelineStage, string> = {
  retouched: 'Retouched',
  qc: 'QC',
  assembled: 'Assembled',
  submitted: 'Submitted',
  approved: 'Approved',
};

export type Pipeline = Record<PipelineStage, boolean>;

export function emptyPipeline(): Pipeline {
  return { retouched: false, qc: false, assembled: false, submitted: false, approved: false };
}

/** Read a stage value from anywhere — a boolean, a string from Elvis, or junk. */
export function normalizeStage(value: unknown): boolean {
  return value === true || value === 'true' || value === 'TRUE' || value === 'YES' || value === 'yes' || value === '1' || value === 1;
}

/**
 * Stages a longshot doesn't go through: a wide establishing frame runs as
 * itself and is never assembled, submitted or approved as a unit. For a
 * longshot these three are hidden and left out of every progress count —
 * hidden, not reset: a value stored before the shot type changed survives.
 */
export const LONGSHOT_EXEMPT_STAGES: PipelineStage[] = ['assembled', 'submitted', 'approved'];

export type Usage = 'none' | 'mag' | 'pr' | 'both';
export type ShotType = 'unassigned' | 'longshot' | 'closeup';
export type SelectType = 'main' | 'alt';
export type Side = 'mag' | 'pr';

export const SIDE_LABELS: Record<Side, string> = { mag: 'Magazine', pr: 'Press release' };

export interface Placement {
  /** Spread # for the magazine side, Slide # for the PR side. */
  position: string;
  selectType: SelectType;
  retoucher: string;
  pipeline: Pipeline;
}

export function emptyPlacement(): Placement {
  return { position: '', selectType: 'main', retoucher: '', pipeline: emptyPipeline() };
}

/* ------------------------------------------------------------------ *
 * Edit stamps — what makes merging between sites possible
 * ------------------------------------------------------------------ */

/** One field's last edit: when, on which installation, and by whom. */
export interface FieldStamp {
  t: number;
  d: string;
  /** The person's name, when known. Shown as "Retouched · by Jo, 14:02". */
  u?: string;
}

export type FieldTimes = Record<string, FieldStamp>;

/** True when stamp `a` should win over `b`. Newer wins; ties break on device id. */
export function isNewerStamp(a: FieldStamp, b: FieldStamp | null | undefined): boolean {
  if (!b) return true;
  if (a.t !== b.t) return a.t > b.t;
  return a.d > b.d;
}

/** Every field path a row tracks provenance for. */
export const ROW_FIELD_PATHS = [
  'shotNum',
  'shotType',
  'usage',
  'notes',
  'elvisAssetId',
  'elvisName',
  'elvisPath',
  'imageHash',
  'mag.position',
  'mag.selectType',
  'mag.retoucher',
  'mag.pipeline.retouched',
  'mag.pipeline.qc',
  'mag.pipeline.assembled',
  'mag.pipeline.submitted',
  'mag.pipeline.approved',
  'pr.position',
  'pr.selectType',
  'pr.retoucher',
  'pr.pipeline.retouched',
  'pr.pipeline.qc',
  'pr.pipeline.assembled',
  'pr.pipeline.submitted',
  'pr.pipeline.approved',
] as const;
export type RowFieldPath = (typeof ROW_FIELD_PATHS)[number];

export const stagePath = (side: Side, stage: PipelineStage) => `${side}.pipeline.${stage}` as RowFieldPath;

/* ------------------------------------------------------------------ *
 * Comments — how an executive's concerns reach the people doing the work
 * ------------------------------------------------------------------ */

export type Role = 'executive' | 'staff';
export type CommentKind = 'concern' | 'note';

/**
 * One comment on a shot. Text is written once and never edited, which is
 * what lets two sites merge threads by simple union. The only thing that
 * changes afterwards is whether it's resolved, and that carries its own
 * stamp (`resolvedAt` + `resolvedDevice`) so the most recent decision wins.
 */
export interface ShotComment {
  id: string;
  kind: CommentKind;
  text: string;
  author: string;
  role: Role;
  at: number;
  /** Which property the comment is about, or null for the shot as a whole. */
  side: Side | null;
  /** Parent comment id for a reply; null for a top-level comment. */
  replyTo: string | null;
  resolved: boolean;
  resolvedBy: string;
  /** When `resolved` last changed. 0 = never. */
  resolvedAt: number;
  resolvedDevice: string;
}

/** Merge two copies of one comment: same text, newest resolution decision. */
export function mergeComment(a: ShotComment, b: ShotComment): ShotComment {
  const aStamp = { t: a.resolvedAt, d: a.resolvedDevice };
  const bStamp = { t: b.resolvedAt, d: b.resolvedDevice };
  return isNewerStamp(bStamp, aStamp)
    ? { ...a, resolved: b.resolved, resolvedBy: b.resolvedBy, resolvedAt: b.resolvedAt, resolvedDevice: b.resolvedDevice }
    : a;
}

/* ------------------------------------------------------------------ *
 * Rows
 * ------------------------------------------------------------------ */

export interface ShotRow {
  id: string;
  shotNum: string;
  shotType: ShotType;
  usage: Usage;
  /** Key into `assets`, or null before a frame is attached. */
  imageHash: string | null;
  mag: Placement;
  pr: Placement;
  /** WoodWing Elvis asset id, once this row is linked to an asset. */
  elvisAssetId: string;
  /** The asset's filename in Elvis, for display. */
  elvisName: string;
  /** The folder the asset lives in, in Elvis. */
  elvisPath: string;
  /** Free-text description of the shot. Discussion goes in `comments`. */
  notes: string;
  comments: Record<string, ShotComment>;
  /** Per-field provenance, consulted when merging another site's changes. */
  fieldTimes: FieldTimes;
}

/** Row id for a shot that came from Elvis — identical at every site. */
export const elvisRowId = (assetId: string) => `elvis-${assetId}`;

export function makeRow(id: string = newId()): ShotRow {
  return {
    id,
    shotNum: '',
    shotType: 'unassigned',
    usage: 'none',
    imageHash: null,
    mag: emptyPlacement(),
    pr: emptyPlacement(),
    elvisAssetId: '',
    elvisName: '',
    elvisPath: '',
    notes: '',
    comments: {},
    fieldTimes: {},
  };
}

/** Read a row field by its dot path, for generic merge/sort code. */
export function getRowField(row: ShotRow, path: RowFieldPath): unknown {
  let cur: unknown = row;
  for (const p of path.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

/** Set a row field by its dot path, returning a new row (rows are never mutated). */
export function setRowField(row: ShotRow, path: RowFieldPath, value: unknown): ShotRow {
  if (!path.includes('.')) {
    return { ...row, [path]: value } as ShotRow;
  }
  const [side, rest] = path.split(/\.(.+)/) as [Side, string];
  const placement = row[side];
  if (!rest.includes('.')) {
    return { ...row, [side]: { ...placement, [rest]: value } };
  }
  const [, stage] = rest.split('.') as ['pipeline', PipelineStage];
  return { ...row, [side]: { ...placement, pipeline: { ...placement.pipeline, [stage]: normalizeStage(value) } } };
}

/** Set a field and record who changed it, in one step. */
export function touchRowField(row: ShotRow, path: RowFieldPath, value: unknown, stamp: FieldStamp): ShotRow {
  const next = setRowField(row, path, value);
  return { ...next, fieldTimes: { ...next.fieldTimes, [path]: stamp } };
}

/**
 * Coerce a row from anywhere — an older file, a delta, an Elvis record — into
 * the current shape. Everything coming from outside passes through here, so
 * no other code has to guess at missing fields.
 */
export function normalizeRow(raw: unknown, fallbackId?: string): ShotRow {
  const r = (raw ?? {}) as Partial<ShotRow> & Record<string, unknown>;
  const base = makeRow(String(r.id ?? fallbackId ?? newId()));
  const placement = (p: unknown): Placement => {
    const src = (p ?? {}) as Partial<Placement> & { pipeline?: Record<string, unknown> };
    const pipeline = emptyPipeline();
    for (const stage of PIPELINE_STAGES) pipeline[stage] = normalizeStage(src.pipeline?.[stage]);
    return {
      position: String(src.position ?? ''),
      selectType: src.selectType === 'alt' ? 'alt' : 'main',
      retoucher: String(src.retoucher ?? ''),
      pipeline,
    };
  };
  const comments: Record<string, ShotComment> = {};
  for (const [id, c] of Object.entries((r.comments ?? {}) as Record<string, Partial<ShotComment>>)) {
    if (!c || typeof c.text !== 'string') continue;
    comments[id] = {
      id,
      kind: c.kind === 'concern' ? 'concern' : 'note',
      text: c.text,
      author: String(c.author ?? ''),
      role: c.role === 'executive' ? 'executive' : 'staff',
      at: Number(c.at ?? 0),
      side: c.side === 'mag' || c.side === 'pr' ? c.side : null,
      replyTo: typeof c.replyTo === 'string' ? c.replyTo : null,
      resolved: Boolean(c.resolved),
      resolvedBy: String(c.resolvedBy ?? ''),
      resolvedAt: Number(c.resolvedAt ?? 0),
      resolvedDevice: String(c.resolvedDevice ?? ''),
    };
  }
  return {
    ...base,
    shotNum: String(r.shotNum ?? ''),
    shotType: isShotType(r.shotType) ? r.shotType : 'unassigned',
    usage: isUsage(r.usage) ? r.usage : 'none',
    imageHash: typeof r.imageHash === 'string' && r.imageHash ? r.imageHash : null,
    mag: placement(r.mag),
    pr: placement(r.pr),
    elvisAssetId: String(r.elvisAssetId ?? ''),
    elvisName: String(r.elvisName ?? ''),
    elvisPath: String(r.elvisPath ?? ''),
    notes: String(r.notes ?? ''),
    comments,
    fieldTimes: (r.fieldTimes && typeof r.fieldTimes === 'object' ? r.fieldTimes : {}) as FieldTimes,
  };
}

/* ------------------------------------------------------------------ *
 * Assets — one entry per distinct image, referenced by hash
 * ------------------------------------------------------------------ */

export interface AssetMeta {
  hash: string;
  /** ~360px longest edge, what the grid renders. */
  thumbUrl: string;
  /** ~1600px longest edge, what the inspector and the printed sheet use. */
  reviewUrl: string;
  width: number;
  height: number;
  /** Original filename, kept for the shot-number extractor and provenance. */
  fileName: string;
  /** Approximate bytes of the stored data URLs, for the project-size readout. */
  bytes: number;
}

/* ------------------------------------------------------------------ *
 * Document
 * ------------------------------------------------------------------ */

export interface Header {
  name: string;
  event: string;
  date: string;
}

export interface SheetConfig {
  paper: 'tabloid' | 'letter' | 'a4';
  orientation: 'portrait' | 'landscape';
  showThumbnails: boolean;
}

export const defaultSheetConfig: SheetConfig = {
  paper: 'tabloid',
  orientation: 'landscape',
  showThumbnails: true,
};

export interface TrackerDocument {
  schemaVersion: number;
  header: Header;
  /** Provenance for `header` as a whole — it has no per-field breakdown. */
  headerTime: FieldStamp | null;
  rows: Record<string, ShotRow>;
  rowIds: string[];
  assets: Record<string, AssetMeta>;
  /** Tombstones so a delta import can carry deletions, not just edits. */
  deletedRowIds: Record<string, FieldStamp>;
  sheet: SheetConfig;
  /**
   * This project has been pulled from Elvis, so automatic sync applies to it.
   * Kept per project so opening an unrelated file never pulls a shoot into it.
   */
  elvisLinked: boolean;
}

export function emptyDocument(): TrackerDocument {
  return {
    schemaVersion: SCHEMA_VERSION,
    header: { name: '', event: '', date: '' },
    headerTime: null,
    rows: {},
    rowIds: [],
    assets: {},
    deletedRowIds: {},
    sheet: { ...defaultSheetConfig },
    elvisLinked: false,
  };
}

/* ------------------------------------------------------------------ *
 * Loading and migration
 * ------------------------------------------------------------------ */

/**
 * A legacy row still carrying its raw embedded image, waiting to go through
 * the resize + hash pipeline in `lib/images.ts`. `migrate` is synchronous, so
 * turning a data URL into a deduped asset happens one layer up, in
 * `lib/projectFiles.ts`.
 */
export interface PendingImage {
  rowId: string;
  dataUrl: string;
  fileName: string;
}

export interface MigrationResult {
  doc: TrackerDocument;
  pending: PendingImage[];
}

/**
 * Bring a loaded file up to the current schema.
 *
 * Steps are additive and chained — a file enters at its own version and walks
 * forward: the original HTML tool's export (a `rows` array, no version) →
 * v1 → v2. Never edit an existing step; add a new one.
 */
export function migrate(raw: unknown): MigrationResult {
  const input = (raw ?? {}) as Record<string, unknown>;

  if (typeof input.schemaVersion === 'number') {
    return { doc: hydrate(input), pending: [] };
  }

  if (Array.isArray(input.rows)) {
    const legacy = migrateLegacyHtmlTool(input);
    return { doc: hydrate({ ...legacy.doc, schemaVersion: 1 }), pending: legacy.pending };
  }

  return { doc: emptyDocument(), pending: [] };
}

/**
 * Fill in anything a native file is missing. v1 rows become v2 by gaining
 * the new fields (`comments`, `elvisName`, `elvisPath`) with empty values,
 * which `normalizeRow` supplies — no stored value changes meaning.
 */
function hydrate(raw: Record<string, unknown>): TrackerDocument {
  const base = emptyDocument();
  const rawRows = (raw.rows ?? {}) as Record<string, unknown>;
  const rows: Record<string, ShotRow> = {};
  for (const [id, r] of Object.entries(rawRows)) rows[id] = normalizeRow(r, id);
  const rowIds = (Array.isArray(raw.rowIds) ? (raw.rowIds as string[]) : Object.keys(rows)).filter((id) => rows[id]);
  return {
    schemaVersion: SCHEMA_VERSION,
    header: { ...base.header, ...((raw.header as Partial<Header>) ?? {}) },
    headerTime: (raw.headerTime as FieldStamp | null | undefined) ?? null,
    rows,
    rowIds,
    assets: (raw.assets as TrackerDocument['assets']) ?? {},
    deletedRowIds: (raw.deletedRowIds as TrackerDocument['deletedRowIds']) ?? {},
    sheet: { ...defaultSheetConfig, ...((raw.sheet as Partial<SheetConfig>) ?? {}) },
    elvisLinked: raw.elvisLinked === true,
  };
}

/* --- original HTML tool (no schemaVersion) → v1 ----------------------- */

interface V1Pipeline {
  retouched: boolean;
  qc: boolean;
  assembled: boolean;
  submitted: boolean;
  approved: boolean;
}

interface V1Row {
  id: string;
  shotNum: string;
  shotType: ShotType;
  usage: Usage;
  imageHash: string | null;
  mag: { position: string; selectType: SelectType; retoucher: string; pipeline: V1Pipeline };
  pr: { position: string; selectType: SelectType; retoucher: string; pipeline: V1Pipeline };
  elvisAssetId: string;
  notes: string;
  fieldTimes: FieldTimes;
}

function makeV1Row(): V1Row {
  const pipeline = (): V1Pipeline => ({ retouched: false, qc: false, assembled: false, submitted: false, approved: false });
  return {
    id: newId(),
    shotNum: '',
    shotType: 'unassigned',
    usage: 'none',
    imageHash: null,
    mag: { position: '', selectType: 'main', retoucher: '', pipeline: pipeline() },
    pr: { position: '', selectType: 'main', retoucher: '', pipeline: pipeline() },
    elvisAssetId: '',
    notes: '',
    fieldTimes: {},
  };
}

/** Legacy toggle order: the ten pipeline buttons in the DOM order the old tool built them. */
const LEGACY_TOGGLE_ORDER: Array<[side: 'mag' | 'pr', stage: PipelineStage]> = [
  ['mag', 'retouched'], ['pr', 'retouched'],
  ['mag', 'qc'], ['pr', 'qc'],
  ['mag', 'assembled'], ['pr', 'assembled'],
  ['mag', 'submitted'], ['pr', 'submitted'],
  ['mag', 'approved'], ['pr', 'approved'],
];

interface LegacyRow {
  shotNum?: string;
  shotType?: string;
  usage?: string;
  posMag?: string;
  posPr?: string;
  selMag?: string;
  selPr?: string;
  retMag?: string;
  retPr?: string;
  elvisAssetId?: string;
  imageSrc?: string;
  toggles?: boolean[];
}

function migrateLegacyHtmlTool(input: Record<string, unknown>): {
  doc: Omit<TrackerDocument, 'rows'> & { rows: Record<string, V1Row> };
  pending: PendingImage[];
} {
  const doc = { ...emptyDocument(), rows: {} as Record<string, V1Row> };
  doc.header.name = String(input.headerName ?? '');
  doc.header.event = String(input.headerEvent ?? '');
  doc.header.date = String(input.headerDate ?? '');

  const pending: PendingImage[] = [];
  const legacyRows = input.rows as LegacyRow[];

  for (const legacy of legacyRows) {
    const row = makeV1Row();
    row.shotNum = legacy.shotNum ?? '';
    row.shotType = isShotType(legacy.shotType) ? legacy.shotType : 'unassigned';
    row.usage = isUsage(legacy.usage) ? legacy.usage : 'none';
    row.mag = {
      ...row.mag,
      position: legacy.posMag ?? '',
      selectType: legacy.selMag === 'alt' ? 'alt' : 'main',
      retoucher: legacy.retMag ?? '',
    };
    row.pr = {
      ...row.pr,
      position: legacy.posPr ?? '',
      selectType: legacy.selPr === 'alt' ? 'alt' : 'main',
      retoucher: legacy.retPr ?? '',
    };
    row.elvisAssetId = legacy.elvisAssetId ?? '';

    const toggles = legacy.toggles ?? [];
    for (let i = 0; i < LEGACY_TOGGLE_ORDER.length; i++) {
      const [side, stage] = LEGACY_TOGGLE_ORDER[i];
      if (toggles[i]) row[side].pipeline[stage] = true;
    }

    // The legacy tool reset assembled/submitted/approved on longshots on
    // every load (a bug this migration deliberately does not repeat) — but a
    // longshot that never had those stages touched should still come across
    // clean, so this only fixes shape, not history.
    doc.rows[row.id] = row;
    doc.rowIds.push(row.id);

    if (legacy.imageSrc) {
      pending.push({ rowId: row.id, dataUrl: legacy.imageSrc, fileName: `${row.shotNum || row.id}.jpg` });
    }
  }

  return { doc, pending };
}

function isShotType(v: unknown): v is ShotType {
  return v === 'unassigned' || v === 'longshot' || v === 'closeup';
}
function isUsage(v: unknown): v is Usage {
  return v === 'none' || v === 'mag' || v === 'pr' || v === 'both';
}

/**
 * Drop assets no row references any more — after a delete, or after opening
 * a project that was hand-edited. Content addressing means this never removes
 * something a visible row still needs, even if two rows share the same frame.
 */
export function pruneUnusedAssets(doc: TrackerDocument): TrackerDocument {
  const used = new Set<string>();
  for (const id of doc.rowIds) {
    const hash = doc.rows[id]?.imageHash;
    if (hash) used.add(hash);
  }
  const keys = Object.keys(doc.assets);
  if (keys.every((k) => used.has(k))) return doc;
  const assets: TrackerDocument['assets'] = {};
  for (const k of keys) if (used.has(k)) assets[k] = doc.assets[k];
  return { ...doc, assets };
}

/** Rough total bytes of everything the document is currently holding. */
export function documentBytes(doc: TrackerDocument): number {
  let total = 0;
  for (const hash in doc.assets) total += doc.assets[hash].bytes;
  return total;
}
