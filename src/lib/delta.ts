import { getDeviceId } from './deviceId';
import {
  ROW_FIELD_PATHS,
  getRowField,
  setRowField,
  type AssetMeta,
  type FieldStamp,
  type Header,
  type RowFieldPath,
  type ShotRow,
  type TrackerDocument,
} from '@/state/schema';

/**
 * Delta export/import — how two units on the same shoot share tracking data
 * with no server between them.
 *
 * Every row field carries its own `{t, d}` edit stamp (see schema.ts). A
 * delta is just "every field stamped after some cutoff, plus the assets they
 * point at, plus any rows deleted after that cutoff" — small, because most
 * of a shoot's fields stop moving once they're set. Merging is a per-field
 * newest-wins comparison, so unrelated edits to the same row from two units
 * (one retouches, the other does layout) combine cleanly instead of one
 * side's whole row clobbering the other's.
 *
 * What this deliberately does not do: merge below the field level (two units
 * editing the exact same field on the exact same row at the same time still
 * resolves last-write-wins, tie-broken by device id) and does not sync the
 * show header per-field — the header is one small block, tracked with one
 * timestamp for all of it.
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
  return (
    typeof raw === 'object' &&
    raw !== null &&
    (raw as Record<string, unknown>).kind === DELTA_KIND
  );
}

/** Everything changed since `since` (epoch ms) — pass 0 for "the whole project". */
export function buildDelta(doc: TrackerDocument, since: number): DeltaFile {
  const rows: Record<string, ShotRow> = {};
  const assetHashes = new Set<string>();

  for (const id of doc.rowIds) {
    const row = doc.rows[id];
    if (!row) continue;
    const touchedSince = Object.values(row.fieldTimes).some((stamp) => stamp.t > since);
    if (!touchedSince) continue;
    rows[id] = row;
    if (row.imageHash) assetHashes.add(row.imageHash);
  }

  const deletedRowIds: Record<string, FieldStamp> = {};
  for (const id in doc.deletedRowIds) {
    if (doc.deletedRowIds[id].t > since) deletedRowIds[id] = doc.deletedRowIds[id];
  }

  const assets: Record<string, AssetMeta> = {};
  for (const hash of assetHashes) {
    if (doc.assets[hash]) assets[hash] = doc.assets[hash];
  }

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

export interface MergeSummary {
  rowsAdded: number;
  rowsUpdated: number;
  rowsDeleted: number;
  fieldsChanged: number;
  headerChanged: boolean;
}

function isNewer(a: FieldStamp, b: FieldStamp | null | undefined): boolean {
  if (!b) return true;
  if (a.t !== b.t) return a.t > b.t;
  return a.d > b.d;
}

function newestStamp(fieldTimes: Record<string, FieldStamp>): FieldStamp | null {
  let best: FieldStamp | null = null;
  for (const key in fieldTimes) {
    if (isNewer(fieldTimes[key], best)) best = fieldTimes[key];
  }
  return best;
}

/** Merge a delta into a local document. Never mutates either input. */
export function mergeDelta(
  local: TrackerDocument,
  delta: DeltaFile,
): { doc: TrackerDocument; summary: MergeSummary } {
  const rows: Record<string, ShotRow> = { ...local.rows };
  let rowIds = [...local.rowIds];
  const assets: Record<string, AssetMeta> = { ...local.assets };
  const deletedRowIds: Record<string, FieldStamp> = { ...local.deletedRowIds };

  const summary: MergeSummary = {
    rowsAdded: 0,
    rowsUpdated: 0,
    rowsDeleted: 0,
    fieldsChanged: 0,
    headerChanged: false,
  };

  for (const hash in delta.assets) {
    if (!assets[hash]) assets[hash] = delta.assets[hash];
  }

  for (const id in delta.rows) {
    const incoming = delta.rows[id];
    const existing = rows[id];

    if (!existing) {
      // New to us — unless we deleted this row after the peer's newest edit
      // to it, in which case the delete stands rather than resurrecting it.
      const tombstone = deletedRowIds[id];
      const incomingNewest = newestStamp(incoming.fieldTimes);
      if (tombstone && incomingNewest && tombstone.t >= incomingNewest.t) continue;
      rows[id] = incoming;
      rowIds.push(id);
      summary.rowsAdded++;
      continue;
    }

    let merged = existing;
    let changedFields = 0;
    for (const path of ROW_FIELD_PATHS as readonly RowFieldPath[]) {
      const incomingStamp = incoming.fieldTimes[path];
      if (!incomingStamp) continue;
      if (isNewer(incomingStamp, existing.fieldTimes[path])) {
        merged = setRowField(merged, path, getRowField(incoming, path));
        merged = { ...merged, fieldTimes: { ...merged.fieldTimes, [path]: incomingStamp } };
        changedFields++;
      }
    }
    if (changedFields > 0) {
      rows[id] = merged;
      summary.rowsUpdated++;
      summary.fieldsChanged += changedFields;
    }
  }

  for (const id in delta.deletedRowIds) {
    const incomingTombstone = delta.deletedRowIds[id];
    const existingTombstone = deletedRowIds[id];
    if (existingTombstone && existingTombstone.t >= incomingTombstone.t) continue;

    const survivor = rows[id];
    const survivorNewest = survivor ? newestStamp(survivor.fieldTimes) : null;
    const editedAfterDelete = Boolean(survivor && survivorNewest && survivorNewest.t > incomingTombstone.t);

    deletedRowIds[id] = incomingTombstone;
    if (survivor && !editedAfterDelete) {
      delete rows[id];
      rowIds = rowIds.filter((rid) => rid !== id);
      summary.rowsDeleted++;
    }
  }

  let header = local.header;
  let headerTime = local.headerTime;
  if (delta.headerTime && isNewer(delta.headerTime, local.headerTime)) {
    header = delta.header;
    headerTime = delta.headerTime;
    summary.headerChanged = true;
  }

  return {
    doc: { ...local, header, headerTime, rows, rowIds, assets, deletedRowIds },
    summary,
  };
}
