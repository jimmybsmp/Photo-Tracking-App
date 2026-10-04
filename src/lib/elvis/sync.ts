import { extractShotNumber } from '@/lib/images';
import { emptySummary, mergeRow, rowChangedAt, type MergeSummary } from '@/lib/delta';
import { sideStatusLabel } from '@/state/selectors';
import {
  elvisRowId,
  makeRow,
  normalizeRow,
  touchRowField,
  type AssetMeta,
  type FieldStamp,
  type FieldTimes,
  type RowFieldPath,
  type ShotRow,
  type Side,
  type TrackerDocument,
} from '@/state/schema';
import { MIRROR_READABLE, type ElvisConfig, type ElvisHit, type ElvisMirrorMap } from './types';

/**
 * Elvis sync rules — pure functions, no network. `autoSync.ts` does the I/O.
 *
 * A pull turns every matching asset into an incoming copy of its shot, then
 * merges that copy into the open project with the same per-field,
 * newest-stamp-wins merge a delta file uses (`mergeRow`). What goes into the
 * incoming copy, strongest first:
 *
 *   1. The PhotoTrack record field, if the asset has one. It carries every
 *      field with its original stamp and the comment thread, written by
 *      whichever site pushed last — so it merges exactly, whoever made it.
 *   2. Facts about the asset itself — filename, folder — stamped with when
 *      Elvis says the asset last changed.
 *   3. A shot number read from the filename, and plain mirror fields when no
 *      record exists yet. These are stamped "as old as possible" (t = 1), so
 *      they fill blanks and never overwrite anything someone actually typed.
 *
 * A push writes back only what differs from what Elvis already holds — the
 * pull that runs first is also the comparison.
 */

export const RECORD_VERSION = 2;

/** The weakest possible stamp: loses to any real edit, fills an empty field. */
const WEAK: FieldStamp = { t: 1, d: 'elvis' };

/** Fields the record carries — everything except what Elvis itself is the source of. */
const NOT_IN_RECORD = new Set<string>(['elvisAssetId', 'elvisName', 'elvisPath', 'imageHash']);

/** Deterministic JSON — the same row always produces the same string, so "changed?" is a string compare. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/** The record-field value for a shot. */
export function recordFor(row: ShotRow): string {
  const fieldTimes: FieldTimes = {};
  for (const [path, stamp] of Object.entries(row.fieldTimes)) {
    // Weak, Elvis-derived stamps travel too: a spread number one site read
    // from a plain field has to reach the others, and being the weakest
    // stamp possible it still loses to anything a person actually typed.
    if (!NOT_IN_RECORD.has(path)) fieldTimes[path] = stamp;
  }
  return canonicalJson({
    phototrack: RECORD_VERSION,
    shotNum: row.shotNum,
    shotType: row.shotType,
    usage: row.usage,
    notes: row.notes,
    mag: row.mag,
    pr: row.pr,
    comments: row.comments,
    fieldTimes,
  });
}

/** Read a record field back into a row, or null if it isn't one of ours. */
export function parseRecord(text: unknown, id: string): ShotRow | null {
  if (typeof text !== 'string' || !text.trim()) return null;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || typeof parsed.phototrack !== 'number') return null;
  const row = normalizeRow({ ...parsed, id }, id);
  const fieldTimes: FieldTimes = {};
  for (const [path, stamp] of Object.entries(row.fieldTimes)) {
    if (!NOT_IN_RECORD.has(path) && stamp && typeof stamp.t === 'number') fieldTimes[path] = stamp;
  }
  return { ...row, fieldTimes };
}

/** Plain-text values for the mirror fields. Status fields are written only. */
export function mirrorValues(row: ShotRow, mirror: ElvisMirrorMap): Record<string, string> {
  const live = (side: Side) => row.usage === side || row.usage === 'both';
  const values: Array<[string, string]> = [
    [mirror.usage, row.usage],
    [mirror.shotType, row.shotType],
    [mirror.magSpread, row.mag.position],
    [mirror.prSlide, row.pr.position],
    [mirror.magRetoucher, row.mag.retoucher],
    [mirror.prRetoucher, row.pr.retoucher],
    [mirror.magStatus, live('mag') ? sideStatusLabel(row, 'mag') : ''],
    [mirror.prStatus, live('pr') ? sideStatusLabel(row, 'pr') : ''],
  ];
  const out: Record<string, string> = {};
  for (const [field, value] of values) if (field.trim()) out[field.trim()] = value;
  return out;
}

/** Everything a push would write for this shot. */
export function payloadFor(row: ShotRow, config: ElvisConfig): Record<string, string> {
  const payload = mirrorValues(row, config.mirror);
  if (config.recordField.trim()) payload[config.recordField.trim()] = recordFor(row);
  return payload;
}

/** True when the configuration writes anything at all. */
export const canPush = (config: ElvisConfig) => Object.keys(payloadFor(makeRow(), config)).length > 0;

/** An Elvis metadata value as the plain text we compare against. */
function asText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return value.map(asText).join(', ');
  if (typeof value === 'object') {
    const v = value as Record<string, unknown>;
    if ('value' in v) return asText(v.value);
    return JSON.stringify(value);
  }
  return String(value);
}

/** When Elvis says the asset last changed, as an edit-stamp time. */
function assetModifiedAt(meta: Record<string, unknown>): number {
  for (const key of ['assetModified', 'metadataModified', 'assetFileModified']) {
    const raw = meta[key];
    const v = raw && typeof raw === 'object' ? (raw as Record<string, unknown>).value : raw;
    const t = typeof v === 'number' ? v : typeof v === 'string' ? Date.parse(v) : NaN;
    if (Number.isFinite(t) && t > 1) return t;
  }
  return 1;
}

const folderOf = (meta: Record<string, unknown>) => {
  const folder = asText(meta.folderPath);
  if (folder) return folder;
  const path = asText(meta.assetPath);
  return path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
};

/* ------------------------------------------------------------------ *
 * Pull
 * ------------------------------------------------------------------ */

export interface PullItem {
  assetId: string;
  /** The row this asset merges into — existing, or the id a new row gets. */
  rowId: string;
  incoming: ShotRow;
  /** Download a picture for it? Only when the shot has none yet. */
  imageUrl: string | null;
  imageName: string;
}

/**
 * Work out what every asset would contribute. Pure: decides, fetches nothing.
 * Matching an asset to a row: one already linked to it, then the id every
 * site derives from the asset id, then an unlinked shot whose number matches
 * the filename — how photos someone dropped in by hand get linked up.
 */
export function planPull(doc: TrackerDocument, hits: ElvisHit[], config: ElvisConfig): PullItem[] {
  const byAsset = new Map<string, string>();
  const unlinkedByShot = new Map<string, string>();
  for (const id of doc.rowIds) {
    const row = doc.rows[id];
    if (!row) continue;
    if (row.elvisAssetId) byAsset.set(row.elvisAssetId, id);
    else if (row.shotNum.trim()) unlinkedByShot.set(row.shotNum.trim().toUpperCase(), id);
  }

  const items: PullItem[] = [];
  for (const hit of hits) {
    if (!hit.id) continue;
    const meta = hit.metadata ?? {};
    const fileName = asText(meta.filename) || asText(meta.name) || hit.name || '';
    const guess = fileName ? extractShotNumber(fileName) : '';

    let rowId = byAsset.get(hit.id) ?? (doc.rows[elvisRowId(hit.id)] ? elvisRowId(hit.id) : undefined);
    if (!rowId && guess && unlinkedByShot.has(guess.toUpperCase())) {
      rowId = unlinkedByShot.get(guess.toUpperCase());
      unlinkedByShot.delete(guess.toUpperCase());
    }
    rowId = rowId ?? elvisRowId(hit.id);

    const modified = { t: assetModifiedAt(meta), d: 'elvis' };
    let incoming = makeRow(rowId);
    incoming = touchRowField(incoming, 'elvisAssetId', hit.id, WEAK);
    if (fileName) incoming = touchRowField(incoming, 'elvisName', fileName, modified);
    const folder = folderOf(meta);
    if (folder) incoming = touchRowField(incoming, 'elvisPath', folder, modified);
    if (guess) incoming = touchRowField(incoming, 'shotNum', guess, WEAK);

    const record = config.recordField.trim() ? parseRecord(meta[config.recordField.trim()], rowId) : null;
    if (record) {
      incoming = mergeRow(incoming, record).row;
    } else {
      incoming = applyMirrorFields(incoming, meta, config.mirror);
    }

    const local = doc.rows[rowId];
    const imageUrl = local?.imageHash ? null : hit.previewUrl || hit.thumbnailUrl || null;
    items.push({ assetId: hit.id, rowId, incoming, imageUrl, imageName: fileName || hit.id });
  }
  return items;
}

/** First-pull values from plain fields — weak, so they only fill blanks. */
function applyMirrorFields(row: ShotRow, meta: Record<string, unknown>, mirror: ElvisMirrorMap): ShotRow {
  const read = (key: keyof ElvisMirrorMap) => (mirror[key].trim() ? asText(meta[mirror[key].trim()]).trim() : '');
  let next = row;
  const set = (path: RowFieldPath, value: string) => {
    if (value) next = touchRowField(next, path, value, WEAK);
  };
  for (const key of MIRROR_READABLE) {
    const value = read(key);
    if (!value) continue;
    if (key === 'usage') {
      const v = value.toLowerCase();
      const usage = v === 'both' ? 'both' : v.startsWith('mag') ? 'mag' : v === 'pr' || v.startsWith('press') ? 'pr' : '';
      set('usage', usage);
    } else if (key === 'shotType') {
      const v = value.toLowerCase().replace(/[\s-]/g, '');
      set('shotType', v.startsWith('long') ? 'longshot' : v.startsWith('close') ? 'closeup' : '');
    } else if (key === 'magSpread') set('mag.position', value);
    else if (key === 'prSlide') set('pr.position', value);
    else if (key === 'magRetoucher') set('mag.retoucher', value);
    else if (key === 'prRetoucher') set('pr.retoucher', value);
  }
  return next;
}

/**
 * Merge a planned pull into a document — run against the *current* document,
 * at the moment of applying, so anything typed while the network was busy is
 * merged rather than overwritten.
 */
export function applyPull(
  doc: TrackerDocument,
  items: PullItem[],
  images: Map<string, AssetMeta>,
): { doc: TrackerDocument; summary: MergeSummary } {
  const summary = emptySummary();
  const rows = { ...doc.rows };
  const rowIds = [...doc.rowIds];
  const assets = { ...doc.assets };
  let touched = false;

  for (const item of items) {
    let incoming = item.incoming;
    const image = images.get(item.assetId);
    if (image) {
      if (!assets[image.hash]) assets[image.hash] = image;
      incoming = touchRowField(incoming, 'imageHash', image.hash, WEAK);
    }

    const local = rows[item.rowId];
    if (!local) {
      // Deleted here: stays deleted unless someone has worked on it since.
      const tombstone = doc.deletedRowIds[item.rowId];
      if (tombstone && rowChangedAt(incoming) <= tombstone.t) continue;
      rows[item.rowId] = incoming;
      rowIds.push(item.rowId);
      summary.rowsAdded++;
      touched = true;
      continue;
    }

    const result = mergeRow(local, incoming);
    if (result.row !== local) {
      rows[item.rowId] = result.row;
      summary.rowsUpdated++;
      summary.fieldsChanged += result.fieldsChanged;
      summary.commentsChanged += result.commentsChanged;
      touched = true;
    }
  }

  if (!touched && doc.elvisLinked) return { doc, summary };
  return { doc: { ...doc, rows, rowIds, assets, elvisLinked: true }, summary };
}

/* ------------------------------------------------------------------ *
 * Push
 * ------------------------------------------------------------------ */

export interface PushItem {
  assetId: string;
  rowId: string;
  metadata: Record<string, string>;
}

/**
 * What to write back: for each linked shot, the fields whose value here
 * differs from what Elvis returned in the pull just made. Nothing else is
 * sent, so an idle project makes no writes at all.
 */
export function planPush(doc: TrackerDocument, hits: ElvisHit[], config: ElvisConfig): PushItem[] {
  const byId = new Map(hits.map((h) => [h.id, h]));
  const items: PushItem[] = [];
  for (const id of doc.rowIds) {
    const row = doc.rows[id];
    if (!row?.elvisAssetId) continue;
    const hit = byId.get(row.elvisAssetId);
    if (!hit) continue; // no longer matched by the query — leave it alone
    const desired = payloadFor(row, config);
    const metadata: Record<string, string> = {};
    for (const [field, value] of Object.entries(desired)) {
      if (asText(hit.metadata?.[field]) !== value) metadata[field] = value;
    }
    if (Object.keys(metadata).length > 0) items.push({ assetId: row.elvisAssetId, rowId: id, metadata });
  }
  return items;
}
