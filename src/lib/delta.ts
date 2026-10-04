import { getDeviceId } from './deviceId';
import {
  ROW_FIELD_PATHS,
  getRowField,
  isNewerStamp,
  mergeComment,
  normalizeRow,
  setRowField,
  type AssetMeta,
  type FieldStamp,
  type Header,
  type ShotComment,
  type ShotRow,
  type TrackerDocument,
} from '@/state/schema';

/**
 * Delta export/import — and the merge rule every sync path shares.
 *
 * Every row field carries its own `{t, d, u}` stamp (see schema.ts). Merging
 * compares stamps field by field and keeps the newer, so unrelated edits to
 * one shot from two places (one site retouches, another sets the spread)
 * combine instead of one whole row overwriting the other. Comments merge by
 * union — text is never edited after posting — and a comment's resolved/open
 * state follows its own newest stamp.
 *
 * `mergeRow` is used by delta import and by Elvis pull alike: a pull is just
 * a delta whose other side is the shared Elvis record.
 *
 * Deliberate limits: two people changing the *same* field on the same shot at
 * the same moment still resolves to one winner (newest, tie-broken by
 * device), and the show header merges as one block.
 */

export const DELTA_KIND = 'phototrack-delta';

export interface DeltaFile {
  kind: typeof DELTA_KIND;
  version: 1;
  exportedAt: number;
  exportedBy: string;
  since: number;
  header: Header;
  headerTime: FieldStamp | null;
  rows: Record<string, ShotRow>;
  deletedRowIds: Record<string, FieldStamp>;
  assets: Record<string, AssetMeta>;
}

export function isDeltaFile(raw: unknown): raw is DeltaFile {
  return typeof raw === 'object' && raw !== null && (raw as Record<string, unknown>).kind === DELTA_KIND;
}

/** The newest moment anything on this row changed — fields or comments. */
export function rowChangedAt(row: ShotRow): number {
  let t = 0;
  for (const key in row.fieldTimes) t = Math.max(t, row.fieldTimes[key].t);
  for (const c of Object.values(row.comments)) t = Math.max(t, c.at, c.resolvedAt);
  return t;
}

function newestStamp(fieldTimes: Record<string, FieldStamp>): FieldStamp | null {
  let best: FieldStamp | null = null;
  for (const key in fieldTimes) if (isNewerStamp(fieldTimes[key], best)) best = fieldTimes[key];
  return best;
}

/** Everything changed since `since` (epoch ms) — pass 0 for the whole project. */
export function buildDelta(doc: TrackerDocument, since: number): DeltaFile {
  const rows: Record<string, ShotRow> = {};
  const assetHashes = new Set<string>();

  for (const id of doc.rowIds) {
    const row = doc.rows[id];
    if (!row || rowChangedAt(row) <= since) continue;
    rows[id] = row;
    if (row.imageHash) assetHashes.add(row.imageHash);
  }

  const deletedRowIds: Record<string, FieldStamp> = {};
  for (const id in doc.deletedRowIds) {
    if (doc.deletedRowIds[id].t > since) deletedRowIds[id] = doc.deletedRowIds[id];
  }

  const assets: Record<string, AssetMeta> = {};
  for (const hash of assetHashes) if (doc.assets[hash]) assets[hash] = doc.assets[hash];

  return {
    kind: DELTA_KIND,
    version: 1,
    exportedAt: Date.now(),
    exportedBy: getDeviceId(),
    since,
    header: doc.header,
    headerTime: doc.headerTime,
    rows,
    deletedRowIds,
    assets,
  };
}

export interface RowMergeResult {
  row: ShotRow;
  fieldsChanged: number;
  commentsChanged: number;
}

/**
 * Merge another copy of a shot into ours. Returns the same `local` object
 * when nothing changed, so callers can skip a store update entirely. The
 * row's own id is kept — the incoming copy may know it under another id.
 */
export function mergeRow(local: ShotRow, incoming: ShotRow): RowMergeResult {
  let row = local;
  let fieldsChanged = 0;
  for (const path of ROW_FIELD_PATHS) {
    const stamp = incoming.fieldTimes[path];
    if (!stamp || !isNewerStamp(stamp, local.fieldTimes[path])) continue;
    row = setRowField(row, path, getRowField(incoming, path));
    row = { ...row, fieldTimes: { ...row.fieldTimes, [path]: stamp } };
    fieldsChanged++;
  }

  let comments: Record<string, ShotComment> | null = null;
  let commentsChanged = 0;
  for (const [id, theirs] of Object.entries(incoming.comments)) {
    const ours = local.comments[id];
    const merged = ours ? mergeComment(ours, theirs) : theirs;
    if (merged === ours) continue;
    comments = comments ?? { ...local.comments };
    comments[id] = merged;
    commentsChanged++;
  }
  if (comments) row = { ...row, comments };

  return { row, fieldsChanged, commentsChanged };
}

export interface MergeSummary {
  rowsAdded: number;
  rowsUpdated: number;
  rowsDeleted: number;
  fieldsChanged: number;
  commentsChanged: number;
  headerChanged: boolean;
}

export const emptySummary = (): MergeSummary => ({
  rowsAdded: 0,
  rowsUpdated: 0,
  rowsDeleted: 0,
  fieldsChanged: 0,
  commentsChanged: 0,
  headerChanged: false,
});

export const summaryChanged = (s: MergeSummary) =>
  s.rowsAdded + s.rowsUpdated + s.rowsDeleted > 0 || s.headerChanged;

/** Merge a delta into a local document. Never mutates either input. */
export function mergeDelta(local: TrackerDocument, delta: DeltaFile): { doc: TrackerDocument; summary: MergeSummary } {
  const rows: Record<string, ShotRow> = { ...local.rows };
  let rowIds = [...local.rowIds];
  const assets: Record<string, AssetMeta> = { ...local.assets };
  const deletedRowIds: Record<string, FieldStamp> = { ...local.deletedRowIds };
  const summary = emptySummary();

  for (const hash in delta.assets) if (!assets[hash]) assets[hash] = delta.assets[hash];

  // The same Elvis asset can sit under different row ids at two sites (one
  // pulled it before row ids were derived from asset ids, or linked a
  // dropped photo by hand) — match those up instead of duplicating the shot.
  const byAsset = new Map<string, string>();
  for (const id of rowIds) {
    const a = rows[id]?.elvisAssetId;
    if (a) byAsset.set(a, id);
  }

  for (const [incomingId, raw] of Object.entries(delta.rows)) {
    const incoming = normalizeRow(raw, incomingId);
    const localId = rows[incomingId] ? incomingId : (incoming.elvisAssetId && byAsset.get(incoming.elvisAssetId)) || null;

    if (!localId) {
      // New to us — unless we deleted it after the other side's last edit.
      const tombstone = deletedRowIds[incomingId];
      const newest = newestStamp(incoming.fieldTimes);
      if (tombstone && newest && tombstone.t >= newest.t) continue;
      rows[incomingId] = incoming;
      rowIds.push(incomingId);
      if (incoming.elvisAssetId) byAsset.set(incoming.elvisAssetId, incomingId);
      summary.rowsAdded++;
      continue;
    }

    const result = mergeRow(rows[localId], incoming);
    if (result.row !== rows[localId]) {
      rows[localId] = result.row;
      summary.rowsUpdated++;
      summary.fieldsChanged += result.fieldsChanged;
      summary.commentsChanged += result.commentsChanged;
    }
  }

  for (const id in delta.deletedRowIds) {
    const incomingTombstone = delta.deletedRowIds[id];
    const existingTombstone = deletedRowIds[id];
    if (existingTombstone && existingTombstone.t >= incomingTombstone.t) continue;

    const survivor = rows[id];
    const survivorNewest = survivor ? rowChangedAt(survivor) : 0;
    deletedRowIds[id] = incomingTombstone;
    // Edited here after they deleted it: keep it — an edit is stronger
    // evidence of intent than a delete made elsewhere without seeing it.
    if (survivor && survivorNewest <= incomingTombstone.t) {
      delete rows[id];
      rowIds = rowIds.filter((rid) => rid !== id);
      summary.rowsDeleted++;
    }
  }

  let header = local.header;
  let headerTime = local.headerTime;
  if (delta.headerTime && isNewerStamp(delta.headerTime, local.headerTime)) {
    header = delta.header;
    headerTime = delta.headerTime;
    summary.headerChanged = true;
  }

  return { doc: { ...local, header, headerTime, rows, rowIds, assets, deletedRowIds }, summary };
}
