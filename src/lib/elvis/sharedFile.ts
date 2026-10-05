import { buildDelta, emptySummary, mergeDelta, summaryChanged, type DeltaFile, type MergeSummary } from '@/lib/delta';
import { getDeviceId } from '@/lib/deviceId';
import { emptyDocument, type AssetMeta, type ShotRow, type TrackerDocument } from '@/state/schema';

/**
 * The shared tracking file — rules only, no network (`autoSync.ts` does the
 * I/O).
 *
 * One file in Elvis per shoot, e.g. /PhotoTrack/Gala 2026.ptdelta, in the
 * ordinary delta format: every shot, every stamp, every comment. A sync
 * downloads it, merges it in with `mergeDelta` — the same merge a delta file
 * dropped on the app gets — and checks in a new version only when this site
 * holds something the file lacks. So an idle site never writes, and the
 * file's version history in Elvis is a record of real changes.
 *
 * Two sites can check in at the same moment, and the later version then
 * lacks the earlier one's changes. Nothing is lost: the earlier site still
 * has them, sees on its next sync that the file is missing them, and checks
 * them in again. Every site keeps a full copy and merges by stamp, so the
 * file always converges.
 *
 * Pictures are kept out of it, so the file that changes with every tick stays
 * a few kilobytes per shot:
 *   - A shot linked to Elvis gets its picture from its own asset at every
 *     site, so neither the picture nor a reference to it travels.
 *   - A shot not in Elvis yet — a JPEG the selector dropped in — has its
 *     thumbnail in a companion file beside the main one
 *     (…/Gala 2026.photos.ptdelta). That one only changes when new photos
 *     are dropped in, never when a stage is ticked.
 */

export const TRACKING_FOLDER = '/PhotoTrack';
const TRACKING_EXT = /\.ptdelta$/i;

/** A starting suggestion for the file's path, from the shoot's own name. */
export function suggestTrackingPath(header: { event: string; name: string }): string {
  const name = (header.event || header.name || 'Shoot').replace(/[/\\:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim();
  return `${TRACKING_FOLDER}/${name || 'Shoot'}.ptdelta`;
}

/** Is this path usable — absolute, with a folder and a file name? */
export function trackingPathProblem(path: string): string | null {
  const p = path.trim();
  if (!p) return 'Choose where the shared file lives, e.g. /PhotoTrack/Gala 2026.ptdelta';
  if (!p.startsWith('/')) return 'Start the path with a folder, e.g. /PhotoTrack/…';
  if (p.endsWith('/')) return 'End the path with a file name, e.g. …/Gala 2026.ptdelta';
  if (p.lastIndexOf('/') === 0) return 'Put the file in a folder of its own, e.g. /PhotoTrack/…';
  if (!TRACKING_EXT.test(p)) return 'End the file name with .ptdelta';
  if (/\.photos\.ptdelta$/i.test(p)) return 'That is the photos file that sits beside a shared file — choose the shared file itself';
  return null;
}

/** The companion file holding thumbnails of shots not in Elvis yet. */
export const photosPathFor = (path: string) => path.trim().replace(TRACKING_EXT, '.photos.ptdelta');

/** A row as it goes into the file: no picture reference for a shot linked to Elvis. */
function forFile(row: ShotRow): ShotRow {
  if (!row.elvisAssetId || !row.imageHash) return row;
  const { imageHash: _dropped, ...fieldTimes } = row.fieldTimes;
  return { ...row, imageHash: null, fieldTimes };
}

/** What this site would check in: the whole shoot, no pixels. */
export function sharedPayload(doc: TrackerDocument): DeltaFile {
  const delta = buildDelta(doc, 0);
  const rows: Record<string, ShotRow> = {};
  for (const [id, row] of Object.entries(delta.rows)) rows[id] = forFile(row);
  return { ...delta, rows, assets: {} };
}

/** The pictures only this project has: shots not linked to Elvis. */
function unlinkedImageHashes(doc: TrackerDocument): string[] {
  const hashes = new Set<string>();
  for (const id of doc.rowIds) {
    const row = doc.rows[id];
    if (row && !row.elvisAssetId && row.imageHash && doc.assets[row.imageHash]) hashes.add(row.imageHash);
  }
  return [...hashes];
}

/** A thumbnail-only copy of a picture — enough to recognise the shot at another site. */
const thumbOnly = (asset: AssetMeta): AssetMeta => ({ ...asset, reviewUrl: '' });

/** The photos companion: thumbnails of every shot not in Elvis yet, and nothing else. */
export function photosPayload(doc: TrackerDocument): DeltaFile {
  const assets: Record<string, AssetMeta> = {};
  for (const hash of unlinkedImageHashes(doc)) assets[hash] = thumbOnly(doc.assets[hash]);
  return {
    kind: 'phototrack-delta',
    version: 1,
    exportedAt: Date.now(),
    exportedBy: getDeviceId(),
    since: 0,
    header: doc.header,
    headerTime: null,
    rows: {},
    deletedRowIds: {},
    assets,
  };
}

/**
 * Merge every copy of the file into the project. Normally one copy; two only
 * if two sites created the file in the same instant — then both are read,
 * so neither one's work is stranded.
 */
export function mergeShared(doc: TrackerDocument, copies: DeltaFile[]): { doc: TrackerDocument; summary: MergeSummary } {
  const summary = emptySummary();
  let next = doc;
  for (const copy of copies) {
    const result = mergeDelta(next, copy);
    next = result.doc;
    summary.rowsAdded += result.summary.rowsAdded;
    summary.rowsUpdated += result.summary.rowsUpdated;
    summary.rowsDeleted += result.summary.rowsDeleted;
    summary.fieldsChanged += result.summary.fieldsChanged;
    summary.commentsChanged += result.summary.commentsChanged;
    summary.headerChanged = summary.headerChanged || result.summary.headerChanged;
  }
  return { doc: summaryChanged(summary) ? next : doc, summary };
}

/**
 * Take the thumbnails this project is missing from the photos file — only
 * for shots it has, and never over a full-size picture it already holds.
 */
export function mergePhotos(doc: TrackerDocument, copies: DeltaFile[]): { doc: TrackerDocument; added: number } {
  const wanted = new Set(doc.rowIds.map((id) => doc.rows[id]?.imageHash).filter((h): h is string => Boolean(h)));
  let assets: Record<string, AssetMeta> | null = null;
  let added = 0;
  for (const copy of copies) {
    for (const [hash, asset] of Object.entries(copy.assets)) {
      if (!wanted.has(hash) || doc.assets[hash] || assets?.[hash]) continue;
      assets = assets ?? { ...doc.assets };
      assets[hash] = asset;
      added++;
    }
  }
  return { doc: assets ? { ...doc, assets } : doc, added };
}

/**
 * Does the file lack anything this site has? Asked by merging what we'd
 * check in into what the file holds and seeing whether that changes it —
 * the same question, by the same rules, every other site asks. `null` means
 * there is no file yet.
 */
export function fileNeedsUpdate(doc: TrackerDocument, current: DeltaFile | null): boolean {
  const payload = sharedPayload(doc);
  if (!current) return Object.keys(payload.rows).length > 0 || payload.headerTime !== null;
  const asFile = mergeDelta(emptyDocument(), current).doc;
  return summaryChanged(mergeDelta(asFile, payload).summary);
}

/** Does the photos file lack a thumbnail of a shot only this site can see? */
export function photosNeedUpdate(doc: TrackerDocument, current: DeltaFile | null): boolean {
  const needed = unlinkedImageHashes(doc);
  if (!current) return needed.length > 0;
  return needed.some((hash) => !current.assets[hash]);
}
