import { create } from 'zustand';
import { deepClone } from '@/lib/compat';
import { getDeviceId } from '@/lib/deviceId';
import { extractShotNumber } from '@/lib/images';
import { resetHistory } from './history';
import {
  LONGSHOT_EXEMPT_STAGES,
  emptyDocument,
  makeRow,
  pruneUnusedAssets,
  setRowField,
  touchRowField,
  type AssetMeta,
  type PipelineStage,
  type RowFieldPath,
  type SelectType,
  type ShotType,
  type TrackerDocument,
  type Usage,
} from './schema';

/**
 * Why the state is shaped this way.
 *
 * Rows live in an id-keyed record with the draw order held apart in
 * `rowIds`, same reasoning as OpticPlan's objects/objectIds split: reordering
 * the grid or the sheet must not force every row's own cells to re-render.
 *
 * `usage` and `shotType` are read-only signals for the UI and for the stats
 * dashboard — they decide which side (mag/pr) is shown and which pipeline
 * stages apply, but switching either one never deletes or resets a field.
 * That is a deliberate fix: the original tool cleared the position field
 * when usage changed sides, and reset three pipeline toggles every time a
 * file loaded with a longshot in it. A value the user typed is never
 * discarded by a display decision here.
 */

const nid = () => getDeviceId();

export type ViewMode = 'grid' | 'sheet';
export type UsageFilter = 'all' | Usage;
export type ShotTypeFilter = 'all' | ShotType;
export type SelectFilter = 'all' | SelectType;

interface Filters {
  usage: UsageFilter;
  shotType: ShotTypeFilter;
  select: SelectFilter;
  search: string;
}

const defaultFilters: Filters = { usage: 'all', shotType: 'all', select: 'all', search: '' };

interface UiState {
  view: ViewMode;
  filters: Filters;
  selectedRowIds: string[];
  activeRowId: string | null;
  gridZoom: number;
  currentPath: string | null;
  savedRevision: number;
}

interface TrackerStore extends UiState {
  doc: TrackerDocument;
  revision: number;

  setDoc: (doc: TrackerDocument, path?: string | null) => void;
  newProject: () => void;
  markSaved: (path: string | null) => void;
  isDirty: () => boolean;

  setHeader: (patch: Partial<TrackerDocument['header']>) => void;

  addRow: () => string;
  addRowsFromAssets: (assets: AssetMeta[]) => string[];
  deleteRows: (rowIds: string[]) => void;
  reorderRow: (rowId: string, beforeRowId: string | null) => void;

  setField: (rowId: string, path: RowFieldPath, value: unknown) => void;
  setUsage: (rowId: string, usage: Usage) => void;
  setShotType: (rowId: string, shotType: ShotType) => void;
  togglePipeline: (rowId: string, side: 'mag' | 'pr', stage: PipelineStage) => void;
  /** Point a row at an asset already known by hash — creating it if it's new
   *  to this document — and guess the shot number if the row doesn't have
   *  one yet. Used for a single drop onto one tile, reassigning its photo. */
  assignImage: (rowId: string, asset: AssetMeta) => void;

  batchSetPipeline: (rowIds: string[], stage: PipelineStage, value: boolean) => void;
  batchSetRetoucher: (rowIds: string[], retoucher: string) => void;

  /** Replace the document with the result of a delta merge, as a normal
   *  edit — unlike `setDoc`, this keeps undo history, so merging a peer's
   *  delta file is one more thing Cmd+Z can back out of. */
  applyMergedDoc: (doc: TrackerDocument) => void;

  setFilters: (patch: Partial<Filters>) => void;
  setView: (view: ViewMode) => void;
  setGridZoom: (zoom: number) => void;

  select: (rowIds: string[]) => void;
  toggleSelect: (rowId: string, additive: boolean) => void;
  clearSelection: () => void;
  setActiveRow: (rowId: string | null) => void;
}

const initialDoc = emptyDocument();

export const useTrackerStore = create<TrackerStore>((set, get) => ({
  doc: initialDoc,
  revision: 0,
  view: 'grid',
  filters: { ...defaultFilters },
  selectedRowIds: [],
  activeRowId: null,
  gridZoom: 1,
  currentPath: null,
  savedRevision: 0,

  setDoc: (doc, path = null) => {
    resetHistory();
    set((s) => ({
      doc,
      revision: s.revision + 1,
      savedRevision: s.revision + 1,
      currentPath: path,
      selectedRowIds: [],
      activeRowId: null,
    }));
  },

  newProject: () => {
    resetHistory();
    set((s) => ({
      doc: emptyDocument(),
      revision: s.revision + 1,
      savedRevision: s.revision + 1,
      currentPath: null,
      selectedRowIds: [],
      activeRowId: null,
    }));
  },

  markSaved: (path) => set((s) => ({ currentPath: path, savedRevision: s.revision })),
  isDirty: () => get().revision !== get().savedRevision,

  setHeader: (patch) =>
    set((s) => ({
      doc: {
        ...s.doc,
        header: { ...s.doc.header, ...patch },
        headerTime: { t: Date.now(), d: nid() },
      },
      revision: s.revision + 1,
    })),

  addRow: () => {
    const row = makeRow();
    set((s) => ({
      doc: { ...s.doc, rows: { ...s.doc.rows, [row.id]: row }, rowIds: [...s.doc.rowIds, row.id] },
      revision: s.revision + 1,
    }));
    return row.id;
  },

  addRowsFromAssets: (assets) => {
    const ids: string[] = [];
    const device = nid();
    const at = Date.now();
    set((s) => {
      const rows = { ...s.doc.rows };
      const newAssets = { ...s.doc.assets };
      const rowIds = [...s.doc.rowIds];

      // A hash already tracked by an existing row is treated as "already
      // imported" rather than creating a second row for the same frame —
      // the common accident is a folder or a single photo getting dropped
      // twice, not two genuinely different shots sharing identical bytes.
      const usedHashes = new Set<string>();
      for (const id of rowIds) {
        const h = rows[id]?.imageHash;
        if (h) usedHashes.add(h);
      }

      for (const asset of assets) {
        if (!newAssets[asset.hash]) newAssets[asset.hash] = asset;
        if (usedHashes.has(asset.hash)) continue;
        usedHashes.add(asset.hash);

        let row = makeRow();
        row = touchRowField(row, 'imageHash', asset.hash, device, at);
        const guess = extractShotNumber(asset.fileName);
        if (guess) row = touchRowField(row, 'shotNum', guess, device, at);
        rows[row.id] = row;
        rowIds.push(row.id);
        ids.push(row.id);
      }
      return { doc: { ...s.doc, rows, rowIds, assets: newAssets }, revision: s.revision + 1 };
    });
    return ids;
  },

  deleteRows: (rowIds) => {
    if (rowIds.length === 0) return;
    const at = Date.now();
    const device = nid();
    set((s) => {
      const rows = { ...s.doc.rows };
      const deletedRowIds = { ...s.doc.deletedRowIds };
      for (const id of rowIds) {
        delete rows[id];
        deletedRowIds[id] = { t: at, d: device };
      }
      const rowIdSet = new Set(rowIds);
      const nextRowIds = s.doc.rowIds.filter((id) => !rowIdSet.has(id));
      const nextDoc = pruneUnusedAssets({ ...s.doc, rows, rowIds: nextRowIds, deletedRowIds });
      return {
        doc: nextDoc,
        revision: s.revision + 1,
        selectedRowIds: s.selectedRowIds.filter((id) => !rowIdSet.has(id)),
        activeRowId: rowIdSet.has(s.activeRowId ?? '') ? null : s.activeRowId,
      };
    });
  },

  reorderRow: (rowId, beforeRowId) =>
    set((s) => {
      const without = s.doc.rowIds.filter((id) => id !== rowId);
      const insertAt = beforeRowId ? without.indexOf(beforeRowId) : without.length;
      const at = insertAt < 0 ? without.length : insertAt;
      const rowIds = [...without.slice(0, at), rowId, ...without.slice(at)];
      return { doc: { ...s.doc, rowIds }, revision: s.revision + 1 };
    }),

  setField: (rowId, path, value) =>
    set((s) => {
      const row = s.doc.rows[rowId];
      if (!row) return s;
      const next = touchRowField(row, path, value, nid());
      return { doc: { ...s.doc, rows: { ...s.doc.rows, [rowId]: next } }, revision: s.revision + 1 };
    }),

  setUsage: (rowId, usage) => get().setField(rowId, 'usage', usage),

  setShotType: (rowId, shotType) => get().setField(rowId, 'shotType', shotType),

  togglePipeline: (rowId, side, stage) => {
    const row = get().doc.rows[rowId];
    if (!row) return;
    if (row.shotType === 'longshot' && LONGSHOT_EXEMPT_STAGES.includes(stage)) return;
    const path = `${side}.pipeline.${stage}` as RowFieldPath;
    const current = row[side].pipeline[stage];
    get().setField(rowId, path, !current);
  },

  assignImage: (rowId, asset) => {
    const device = nid();
    const at = Date.now();
    set((s) => {
      const row = s.doc.rows[rowId];
      if (!row) return s;
      const assets = s.doc.assets[asset.hash] ? s.doc.assets : { ...s.doc.assets, [asset.hash]: asset };
      let next = touchRowField(row, 'imageHash', asset.hash, device, at);
      if (!next.shotNum.trim()) {
        const guess = extractShotNumber(asset.fileName);
        if (guess) next = touchRowField(next, 'shotNum', guess, device, at);
      }
      return { doc: { ...s.doc, assets, rows: { ...s.doc.rows, [rowId]: next } }, revision: s.revision + 1 };
    });
  },

  batchSetPipeline: (rowIds, stage, value) => {
    const device = nid();
    const at = Date.now();
    set((s) => {
      const rows = { ...s.doc.rows };
      for (const id of rowIds) {
        const row = rows[id];
        if (!row) continue;
        let next = row;
        for (const side of ['mag', 'pr'] as const) {
          if (row.shotType === 'longshot' && LONGSHOT_EXEMPT_STAGES.includes(stage)) continue;
          next = touchRowField(next, `${side}.pipeline.${stage}` as RowFieldPath, value, device, at);
        }
        rows[id] = next;
      }
      return { doc: { ...s.doc, rows }, revision: s.revision + 1 };
    });
  },

  batchSetRetoucher: (rowIds, retoucher) => {
    const device = nid();
    const at = Date.now();
    set((s) => {
      const rows = { ...s.doc.rows };
      for (const id of rowIds) {
        const row = rows[id];
        if (!row) continue;
        let next = setRowField(row, 'mag.retoucher', retoucher);
        next = { ...next, fieldTimes: { ...next.fieldTimes, ['mag.retoucher']: { t: at, d: device } } };
        next = setRowField(next, 'pr.retoucher', retoucher);
        next = { ...next, fieldTimes: { ...next.fieldTimes, ['pr.retoucher']: { t: at, d: device } } };
        rows[id] = next;
      }
      return { doc: { ...s.doc, rows }, revision: s.revision + 1 };
    });
  },

  applyMergedDoc: (doc) => set((s) => ({ doc, revision: s.revision + 1 })),

  setFilters: (patch) => set((s) => ({ filters: { ...s.filters, ...patch } })),
  setView: (view) => set({ view }),
  setGridZoom: (zoom) => set({ gridZoom: Math.max(0.5, Math.min(2, zoom)) }),

  select: (rowIds) => set({ selectedRowIds: [...rowIds] }),
  toggleSelect: (rowId, additive) =>
    set((s) => {
      if (!additive) {
        const already = s.selectedRowIds.length === 1 && s.selectedRowIds[0] === rowId;
        return { selectedRowIds: already ? [] : [rowId] };
      }
      const has = s.selectedRowIds.includes(rowId);
      return { selectedRowIds: has ? s.selectedRowIds.filter((id) => id !== rowId) : [...s.selectedRowIds, rowId] };
    }),
  clearSelection: () => set({ selectedRowIds: [] }),
  setActiveRow: (rowId) => set({ activeRowId: rowId }),
}));

/** A defensive copy of the current document — used before a destructive load. */
export function snapshotDoc(): TrackerDocument {
  return deepClone(useTrackerStore.getState().doc);
}
