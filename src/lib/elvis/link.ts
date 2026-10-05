import {
  getRowField,
  isNewerStamp,
  pruneUnusedAssets,
  touchRowField,
  type AssetMeta,
  type FieldStamp,
  type RowFieldPath,
  type ShotRow,
  type TrackerDocument,
} from '@/state/schema';
import type { ElvisHit } from './types';

/**
 * Shots linked to Elvis assets — rules only, no network (`autoSync.ts` does
 * the I/O).
 *
 * The workflow this follows: a shot starts as a JPEG someone dropped in. When
 * the retoucher's first pass is in Elvis, they link the shot to that asset
 * (`linkRow`); from then on the shot's picture is the asset's preview, and
 * when a new version is checked in to Elvis the next sync fetches its preview
 * (`planPreviews` → `applyPreviews`). Only linked assets are ever looked at.
 *
 * The link itself — asset id, file name, folder — is an ordinary stamped edit,
 * so it reaches every other site through the shared file and each site then
 * fetches the preview itself. The picture never travels for a linked shot.
 */

/** An Elvis metadata value as plain text. */
export function metaText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return value.map(metaText).join(', ');
  if (typeof value === 'object') {
    const v = value as Record<string, unknown>;
    return 'value' in v ? metaText(v.value) : JSON.stringify(value);
  }
  return String(value);
}

/** When Elvis says the asset last changed, as epoch ms (1 if it doesn't say). */
export function assetModifiedAt(hit: ElvisHit): number {
  const meta = hit.metadata ?? {};
  for (const key of ['assetModified', 'assetFileModified', 'fileModified']) {
    const raw = meta[key];
    const v = raw && typeof raw === 'object' ? (raw as Record<string, unknown>).value : raw;
    const t = typeof v === 'number' ? v : typeof v === 'string' ? Date.parse(v) : NaN;
    if (Number.isFinite(t) && t > 1) return t;
  }
  return 1;
}

/**
 * Elvis's marker for "the file changed": the version number, plus the file's
 * modification time for servers that don't version. A metadata edit doesn't
 * change it, so retagging an asset doesn't refetch its preview.
 */
export function versionOf(hit: ElvisHit): string {
  const meta = hit.metadata ?? {};
  const version = metaText(meta.versionNumber);
  const fileTime = metaText(meta.assetFileModified ?? meta.fileModified);
  return [version, fileTime].filter(Boolean).join('@') || String(assetModifiedAt(hit));
}

export interface AssetFacts {
  assetId: string;
  name: string;
  folder: string;
}

/** The facts about an asset a shot shows: its file name and folder. */
export function factsOf(hit: ElvisHit): AssetFacts {
  const meta = hit.metadata ?? {};
  const name = metaText(meta.filename) || metaText(meta.name) || hit.name || hit.id;
  let folder = metaText(meta.folderPath);
  if (!folder) {
    const path = metaText(meta.assetPath);
    folder = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
  }
  return { assetId: hit.id, name, folder };
}

export const previewUrlOf = (hit: ElvisHit): string | null => hit.previewUrl || hit.thumbnailUrl || null;

/** Every linked asset id in the project, once each. */
export function linkedAssetIds(doc: TrackerDocument): string[] {
  const ids = new Set<string>();
  for (const id of doc.rowIds) {
    const assetId = doc.rows[id]?.elvisAssetId;
    if (assetId) ids.add(assetId);
  }
  return [...ids];
}

/** Rows linked to one asset — normally one; a shot duplicated for both properties can share. */
export function rowsLinkedTo(doc: TrackerDocument, assetId: string): string[] {
  return doc.rowIds.filter((id) => doc.rows[id]?.elvisAssetId === assetId);
}

/** The row already linked to this asset, other than `exceptRowId` — linking it twice is almost always a mistake. */
export function alreadyLinked(doc: TrackerDocument, assetId: string, exceptRowId: string): ShotRow | null {
  const other = rowsLinkedTo(doc, assetId).find((id) => id !== exceptRowId);
  return other ? doc.rows[other] : null;
}

function touchAll(row: ShotRow, values: Array<[RowFieldPath, string | null]>, stamp: FieldStamp): ShotRow {
  let next = row;
  for (const [path, value] of values) next = touchRowField(next, path, value, stamp);
  return next;
}

/**
 * Link a shot to an asset — a person's edit, stamped with their name. With a
 * preview already fetched, the shot's picture becomes that preview at once.
 */
export function linkRow(
  doc: TrackerDocument,
  rowId: string,
  facts: AssetFacts,
  stamp: FieldStamp,
  preview?: { asset: AssetMeta; version: string },
): TrackerDocument {
  const row = doc.rows[rowId];
  if (!row) return doc;
  let next = touchAll(
    row,
    [
      ['elvisAssetId', facts.assetId],
      ['elvisName', facts.name],
      ['elvisPath', facts.folder],
    ],
    stamp,
  );
  let assets = doc.assets;
  let elvisPreviews = doc.elvisPreviews;
  if (preview) {
    next = touchRowField(next, 'imageHash', preview.asset.hash, stamp);
    if (!assets[preview.asset.hash]) assets = { ...assets, [preview.asset.hash]: preview.asset };
    elvisPreviews = { ...elvisPreviews, [facts.assetId]: { version: preview.version, hash: preview.asset.hash } };
  }
  return pruneUnusedAssets({ ...doc, rows: { ...doc.rows, [rowId]: next }, assets, elvisPreviews });
}

/** Unlink a shot. Its current picture stays — nothing is discarded. */
export function unlinkRow(doc: TrackerDocument, rowId: string, stamp: FieldStamp): TrackerDocument {
  const row = doc.rows[rowId];
  if (!row?.elvisAssetId) return doc;
  const assetId = row.elvisAssetId;
  const next = touchAll(
    row,
    [
      ['elvisAssetId', ''],
      ['elvisName', ''],
      ['elvisPath', ''],
    ],
    stamp,
  );
  const rows = { ...doc.rows, [rowId]: next };
  let elvisPreviews = doc.elvisPreviews;
  if (!doc.rowIds.some((id) => rows[id]?.elvisAssetId === assetId)) {
    elvisPreviews = { ...elvisPreviews };
    delete elvisPreviews[assetId];
  }
  return { ...doc, rows, elvisPreviews };
}

export interface PreviewFetch {
  assetId: string;
  url: string;
  version: string;
  name: string;
}

/**
 * Which linked assets need their preview fetched: those this copy has never
 * fetched, and those whose version in Elvis differs from the one it holds.
 */
export function planPreviews(doc: TrackerDocument, hits: ElvisHit[]): PreviewFetch[] {
  const out: PreviewFetch[] = [];
  for (const hit of hits) {
    if (rowsLinkedTo(doc, hit.id).length === 0) continue;
    const version = versionOf(hit);
    const held = doc.elvisPreviews[hit.id];
    const url = previewUrlOf(hit);
    if (!url || (held && held.version === version)) continue;
    out.push({ assetId: hit.id, url, version, name: factsOf(hit).name });
  }
  return out;
}

export interface FetchedPreview {
  assetId: string;
  version: string;
  asset: AssetMeta;
}

/** The stamp for what Elvis itself reports: when the asset changed there, by "Elvis". */
const elvisStamp = (hit: ElvisHit): FieldStamp => ({ t: assetModifiedAt(hit), d: 'elvis', u: 'Elvis' });

/**
 * Put fetched previews on their shots, and keep each linked shot's file name
 * and folder current if the asset was renamed or moved in Elvis. Returns the
 * same document when nothing changed.
 */
export function applyPreviews(doc: TrackerDocument, hits: ElvisHit[], fetched: FetchedPreview[]): TrackerDocument {
  let rows: Record<string, ShotRow> | null = null;
  let assets = doc.assets;
  let elvisPreviews = doc.elvisPreviews;
  const write = (id: string, row: ShotRow) => {
    rows = rows ?? { ...doc.rows };
    rows[id] = row;
  };
  const current = (id: string) => (rows ?? doc.rows)[id];

  for (const hit of hits) {
    const facts = factsOf(hit);
    const stamp = elvisStamp(hit);
    for (const id of rowsLinkedTo(doc, hit.id)) {
      let row = current(id);
      for (const [path, value] of [
        ['elvisName', facts.name],
        ['elvisPath', facts.folder],
      ] as Array<[RowFieldPath, string]>) {
        if (getRowField(row, path) !== value && isNewerStamp(stamp, row.fieldTimes[path])) row = touchRowField(row, path, value, stamp);
      }
      if (row !== current(id)) write(id, row);
    }
  }

  for (const preview of fetched) {
    const stamp: FieldStamp = { t: Date.now(), d: 'elvis', u: 'Elvis' };
    for (const id of rowsLinkedTo(doc, preview.assetId)) {
      const row = current(id);
      if (row.imageHash !== preview.asset.hash) write(id, touchRowField(row, 'imageHash', preview.asset.hash, stamp));
    }
    if (!assets[preview.asset.hash]) assets = { ...assets, [preview.asset.hash]: preview.asset };
    elvisPreviews = { ...elvisPreviews, [preview.assetId]: { version: preview.version, hash: preview.asset.hash } };
  }

  if (!rows && assets === doc.assets && elvisPreviews === doc.elvisPreviews) return doc;
  return pruneUnusedAssets({ ...doc, rows: rows ?? doc.rows, assets, elvisPreviews });
}
