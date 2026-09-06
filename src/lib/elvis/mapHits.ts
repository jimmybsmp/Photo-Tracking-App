import { getDeviceId } from '@/lib/deviceId';
import { extractShotNumber } from '@/lib/images';
import { makeRow, touchRowField, type RowFieldPath, type ShotRow } from '@/state/schema';
import type { ElvisFieldMap, ElvisHit } from './types';

function truthy(v: unknown): boolean {
  return v === true || v === 'true' || v === 'YES' || v === 'yes' || v === '1' || v === 1;
}

const PIPELINE_KEYS: Array<['retouched' | 'qc' | 'assembled' | 'submitted' | 'approved', keyof ElvisFieldMap]> = [
  ['retouched', 'retouched'],
  ['qc', 'qc'],
  ['assembled', 'assembled'],
  ['submitted', 'submitted'],
  ['approved', 'approved'],
];

/**
 * Turn Elvis search hits into rows, matched to what's already tracked by
 * asset id first, then by a shot number guessed from the filename — same
 * matching the old tool used, kept because it is genuinely the only
 * correlation available before a row has ever synced.
 *
 * This produces plain rows with field stamps, not a merge decision — the
 * caller (`sync.ts`) wraps them as a delta and runs them through
 * `mergeDelta`, so a pull from Elvis is subject to the exact same
 * newest-wins-per-field rule as a peer's delta file. One merge path, not two.
 */
export function rowsFromElvisHits(
  hits: ElvisHit[],
  existingRows: Record<string, ShotRow>,
  fieldMap: ElvisFieldMap,
): Record<string, ShotRow> {
  const device = `elvis:${getDeviceId()}`;
  const at = Date.now();
  const rows: Record<string, ShotRow> = {};

  const byAssetId = new Map<string, ShotRow>();
  const unmatched: ShotRow[] = [];
  for (const id in existingRows) {
    const r = existingRows[id];
    if (r.elvisAssetId) byAssetId.set(r.elvisAssetId, r);
    else unmatched.push(r);
  }

  for (const hit of hits) {
    const meta = hit.metadata ?? {};
    let row = byAssetId.get(hit.id);

    if (!row && hit.name) {
      const guess = extractShotNumber(hit.name).toUpperCase();
      row = unmatched.find((r) => r.shotNum.trim().toUpperCase() === guess);
    }
    row = row ? { ...row } : makeRow();
    row = touchRowField(row, 'elvisAssetId', hit.id, device, at);

    const usage = meta[fieldMap.usage];
    if (typeof usage === 'string' && ['none', 'mag', 'pr', 'both'].includes(usage)) {
      row = touchRowField(row, 'usage', usage, device, at);
    }

    const shotType = meta[fieldMap.shotType];
    if (typeof shotType === 'string' && ['unassigned', 'longshot', 'closeup'].includes(shotType)) {
      row = touchRowField(row, 'shotType', shotType, device, at);
    }

    if (meta[fieldMap.spread] != null) {
      row = touchRowField(row, 'mag.position' as RowFieldPath, String(meta[fieldMap.spread]), device, at);
    }
    if (meta[fieldMap.slide] != null) {
      row = touchRowField(row, 'pr.position' as RowFieldPath, String(meta[fieldMap.slide]), device, at);
    }

    for (const side of ['mag', 'pr'] as const) {
      for (const [stage, mapKey] of PIPELINE_KEYS) {
        const raw = meta[fieldMap[mapKey]];
        if (raw != null) {
          row = touchRowField(row, `${side}.pipeline.${stage}` as RowFieldPath, truthy(raw), device, at);
        }
      }
    }

    rows[row.id] = row;
  }

  return rows;
}
