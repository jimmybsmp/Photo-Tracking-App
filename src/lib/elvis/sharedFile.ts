import { buildDelta, emptySummary, mergeDelta, summaryChanged, type DeltaFile, type MergeSummary } from '@/lib/delta';
import { emptyDocument, type AssetMeta, type ShotRow, type TrackerDocument } from '@/state/schema';
import type { ElvisConfig, ElvisHit } from './types';

/**
 * The shared tracking file — rules only, no network (`autoSync.ts` does the
 * I/O, the same split as `sync.ts`).
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
 * Pictures stay out of it. A shot that came from Elvis gets its picture
 * from its own asset at every site, so the file carries no image for it —
 * and no image reference either, which would otherwise point at a picture
 * another site hasn't downloaded yet. Only photos someone dropped in by
 * hand, which exist nowhere else, travel inside the file.
 */

export const TRACKING_FOLDER = '/PhotoTrack';
const TRACKING_FILE = /\.(ptdelta|phototrack)$/i;

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
  if (!TRACKING_FILE.test(p)) return 'End the file name with .ptdelta';
  return null;
}

const metaText = (hit: ElvisHit, key: string) => {
  const v = hit.metadata?.[key];
  return typeof v === 'string' ? v : '';
};

/**
 * The tracking file — or any PhotoTrack file — showing up among the photos.
 * It happens whenever the photo query reaches the folder the file is in,
 * and it must never become a "shot".
 */
export function isTrackingFileHit(hit: ElvisHit, config: Pick<ElvisConfig, 'trackingFile'>): boolean {
  const path = metaText(hit, 'assetPath');
  if (path && config.trackingFile.trim() && path.toLowerCase() === config.trackingFile.trim().toLowerCase()) return true;
  const name = metaText(hit, 'filename') || metaText(hit, 'name') || hit.name || '';
  return TRACKING_FILE.test(name) || TRACKING_FILE.test(path);
}

/** A row as it goes into the file: no picture reference for a shot Elvis already has. */
function forFile(row: ShotRow): ShotRow {
  if (!row.elvisAssetId || !row.imageHash) return row;
  const { imageHash: _dropped, ...fieldTimes } = row.fieldTimes;
  return { ...row, imageHash: null, fieldTimes };
}

/** What this site would check in: the whole shoot, pictures only where Elvis has none. */
export function sharedPayload(doc: TrackerDocument): DeltaFile {
  const delta = buildDelta(doc, 0);
  const rows: Record<string, ShotRow> = {};
  const assets: Record<string, AssetMeta> = {};
  for (const [id, row] of Object.entries(delta.rows)) {
    rows[id] = forFile(row);
    if (!row.elvisAssetId && row.imageHash && delta.assets[row.imageHash]) assets[row.imageHash] = delta.assets[row.imageHash];
  }
  return { ...delta, rows, assets };
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
