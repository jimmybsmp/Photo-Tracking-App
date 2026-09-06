import { getDeviceId } from '@/lib/deviceId';
import { DELTA_KIND, mergeDelta, type DeltaFile, type MergeSummary } from '@/lib/delta';
import { rowsFromElvisHits } from './mapHits';
import type { ElvisConfig, ElvisHit } from './types';
import type { TrackerDocument } from '@/state/schema';

/**
 * Merge a page of Elvis search hits into the document. Reuses the delta
 * merge path (see lib/delta.ts) rather than a second bespoke algorithm: a
 * pull from the DAM is just a delta whose "peer" is the DAM itself, and it
 * gets the same per-field, newest-wins guarantee — a local edit made after
 * the DAM's copy was last touched is never overwritten by a stale pull.
 */
export function mergeElvisHits(
  doc: TrackerDocument,
  hits: ElvisHit[],
  fieldMap: ElvisConfig['fieldMap'],
): { doc: TrackerDocument; summary: MergeSummary } {
  const rows = rowsFromElvisHits(hits, doc.rows, fieldMap);
  const delta: DeltaFile = {
    kind: DELTA_KIND,
    version: 1,
    exportedAt: Date.now(),
    exportedBy: `elvis:${getDeviceId()}`,
    since: 0,
    header: doc.header,
    headerTime: null,
    rows,
    deletedRowIds: {},
    assets: {},
  };
  return mergeDelta(doc, delta);
}

/** What gets written back to Elvis for one row — only the fields it owns. */
export function metadataPatchForRow(
  row: TrackerDocument['rows'][string],
  fieldMap: ElvisConfig['fieldMap'],
): Record<string, unknown> {
  return {
    [fieldMap.usage]: row.usage,
    [fieldMap.shotType]: row.shotType,
    [fieldMap.spread]: row.mag.position,
    [fieldMap.slide]: row.pr.position,
    [fieldMap.retouched]: row.mag.pipeline.retouched || row.pr.pipeline.retouched,
    [fieldMap.qc]: row.mag.pipeline.qc || row.pr.pipeline.qc,
    [fieldMap.assembled]: row.mag.pipeline.assembled || row.pr.pipeline.assembled,
    [fieldMap.submitted]: row.mag.pipeline.submitted || row.pr.pipeline.submitted,
    [fieldMap.approved]: row.mag.pipeline.approved || row.pr.pipeline.approved,
  };
}
