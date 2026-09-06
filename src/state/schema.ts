import { newId } from '@/lib/compat';

/**
 * Project document schema and the load-time migration path.
 *
 * The unit of work is a shot: one frame that may run in the magazine, in a
 * press release, or both — each placement tracked separately because a shot
 * running in both places is retouched, laid out, and approved on two
 * independent tracks with two different people driving them. `mag` and `pr`
 * are always present on a row; `usage` decides which one(s) are live and the
 * UI hides the other, but the data for a hidden side is never discarded —
 * switching usage back and forth must not lose work.
 */

export const SCHEMA_VERSION = 1;

/* ------------------------------------------------------------------ *
 * Pipeline
 * ------------------------------------------------------------------ */

/** The five stages a placement moves through, in order. */
export const PIPELINE_STAGES = ['retouched', 'qc', 'assembled', 'submitted', 'approved'] as const;
export type PipelineStage = (typeof PIPELINE_STAGES)[number];

export type Pipeline = Record<PipelineStage, boolean>;

export function emptyPipeline(): Pipeline {
  return { retouched: false, qc: false, assembled: false, submitted: false, approved: false };
}

/**
 * Stages that don't apply to a longshot: a wide establishing frame runs as
 * itself and is never assembled into a layout, submitted, or approved as a
 * unit — only a close-up select goes through those three stages. Retouch and
 * QC still apply to every shot.
 */
export const LONGSHOT_EXEMPT_STAGES: PipelineStage[] = ['assembled', 'submitted', 'approved'];

export type Usage = 'none' | 'mag' | 'pr' | 'both';
export type ShotType = 'unassigned' | 'longshot' | 'closeup';
export type SelectType = 'main' | 'alt';

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
 * Field-level edit times — what makes delta merge possible
 * ------------------------------------------------------------------ */

/** One field's last edit: when, and by which installation. */
export interface FieldStamp {
  t: number;
  d: string;
}

export type FieldTimes = Record<string, FieldStamp>;

/** Every field path a row tracks provenance for. Order is documentation only. */
export const ROW_FIELD_PATHS = [
  'shotNum',
  'shotType',
  'usage',
  'notes',
  'elvisAssetId',
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

/* ------------------------------------------------------------------ *
 * Rows
 * ------------------------------------------------------------------ */

export interface ShotRow {
  id: string;
  shotNum: string;
  shotType: ShotType;
  usage: Usage;
  /** Key into `assets`, or null before a frame is dropped on this row. */
  imageHash: string | null;
  mag: Placement;
  pr: Placement;
  /** WoodWing Elvis asset id, once a sync adapter has matched this row. */
  elvisAssetId: string;
  notes: string;
  /** Per-field provenance, consulted only when merging a delta file. */
  fieldTimes: FieldTimes;
}

export function makeRow(): ShotRow {
  return {
    id: newId(),
    shotNum: '',
    shotType: 'unassigned',
    usage: 'none',
    imageHash: null,
    mag: emptyPlacement(),
    pr: emptyPlacement(),
    elvisAssetId: '',
    notes: '',
    fieldTimes: {},
  };
}

/** Read a row field by its dot path, for generic (delta-merge, sort) code. */
export function getRowField(row: ShotRow, path: RowFieldPath): unknown {
  const parts = path.split('.');
  let cur: unknown = row;
  for (const p of parts) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

/**
 * Set a row field by its dot path, returning a new row (rows are never
 * mutated in place — the store, undo history, and React all depend on a
 * changed row being a new object).
 */
export function setRowField(row: ShotRow, path: RowFieldPath, value: unknown): ShotRow {
  if (!path.includes('.')) {
    return { ...row, [path]: value } as ShotRow;
  }
  const [side, rest] = path.split(/\.(.+)/) as ['mag' | 'pr', string];
  const placement = row[side];
  if (!rest.includes('.')) {
    return { ...row, [side]: { ...placement, [rest]: value } };
  }
  const [, stage] = rest.split('.') as ['pipeline', PipelineStage];
  return { ...row, [side]: { ...placement, pipeline: { ...placement.pipeline, [stage]: value } } };
}

/** Stamp a field edit and set its value in one step. */
export function touchRowField(
  row: ShotRow,
  path: RowFieldPath,
  value: unknown,
  deviceId: string,
  at: number = Date.now(),
): ShotRow {
  const next = setRowField(row, path, value);
  return { ...next, fieldTimes: { ...next.fieldTimes, [path]: { t: at, d: deviceId } } };
}

/* ------------------------------------------------------------------ *
 * Assets — one entry per distinct image, referenced by hash
 * ------------------------------------------------------------------ */

export interface AssetMeta {
  hash: string;
  /** ~320px longest edge, what the grid renders. */
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
  };
}

/* ------------------------------------------------------------------ *
 * Loading and migration
 * ------------------------------------------------------------------ */

/**
 * A legacy row still carrying its raw embedded image, waiting to go through
 * the resize + hash pipeline in `lib/images.ts`. `migrate` is synchronous —
 * it only reshapes data already in memory — so pulling a data URL apart into
 * a deduped, resized asset (an async, canvas-driven step) happens one layer
 * up, in `lib/projectFiles.ts`, which calls back in here once each pending
 * image has become a real `AssetMeta`.
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
 * Three shapes come through here: this app's own native file at the current
 * version (the common case — just hydrate), an older native version (none
 * yet — `SCHEMA_VERSION` is 1), and a project exported from the original
 * "Photo Production Tracker" HTML tool, recognized by having a `rows` array
 * with no `schemaVersion` at all.
 */
export function migrate(raw: unknown): MigrationResult {
  const input = (raw ?? {}) as Record<string, unknown>;

  if (typeof input.schemaVersion === 'number') {
    return { doc: hydrate(input), pending: [] };
  }

  if (Array.isArray(input.rows)) {
    return migrateLegacyHtmlTool(input);
  }

  return { doc: emptyDocument(), pending: [] };
}

/** Fill in anything a current-version file is missing. */
function hydrate(raw: Record<string, unknown>): TrackerDocument {
  const base = emptyDocument();
  const rows = (raw.rows ?? {}) as Record<string, ShotRow>;
  const rowIds = Array.isArray(raw.rowIds) ? (raw.rowIds as string[]) : Object.keys(rows);
  return {
    schemaVersion: SCHEMA_VERSION,
    header: { ...base.header, ...((raw.header as Partial<Header>) ?? {}) },
    headerTime: (raw.headerTime as FieldStamp | null | undefined) ?? null,
    rows,
    rowIds,
    assets: (raw.assets as TrackerDocument['assets']) ?? {},
    deletedRowIds: (raw.deletedRowIds as TrackerDocument['deletedRowIds']) ?? {},
    sheet: { ...defaultSheetConfig, ...((raw.sheet as Partial<SheetConfig>) ?? {}) },
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

function migrateLegacyHtmlTool(input: Record<string, unknown>): MigrationResult {
  const doc = emptyDocument();
  doc.header.name = String(input.headerName ?? '');
  doc.header.event = String(input.headerEvent ?? '');
  doc.header.date = String(input.headerDate ?? '');

  const pending: PendingImage[] = [];
  const legacyRows = input.rows as LegacyRow[];

  for (const legacy of legacyRows) {
    const row = makeRow();
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
 * a project that was hand-edited. Content addressing means this never
 * removes something a visible row still needs, even if two rows once shared
 * the same frame.
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
