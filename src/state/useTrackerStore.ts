import { create } from 'zustand';
import { newId } from '@/lib/compat';
import { getDeviceId } from '@/lib/deviceId';
import { getIdentity, stampNow } from '@/lib/identity';
import { extractShotNumber } from '@/lib/images';
import { resetHistory } from './history';
import { defaultFilters, type Filters } from './selectors';
import {
  LONGSHOT_EXEMPT_STAGES,
  emptyDocument,
  makeRow,
  pruneUnusedAssets,
  stagePath,
  touchRowField,
  type AssetMeta,
  type CommentKind,
  type PipelineStage,
  type RowFieldPath,
  type ShotComment,
  type ShotRow,
  type Side,
  type TrackerDocument,
} from './schema';

/**
 * Why the state is shaped this way.
 *
 * Rows live in an id-keyed record with the draw order held apart in
 * `rowIds`: editing one row replaces exactly that entry, so views that
 * subscribe per row (grid tiles, sheet lines) re-render only the row that
 * changed.
 *
 * Every write goes through `touchRowField`, which records who changed the
 * field and when. That stamp is how two sites — or a site and Elvis — merge
 * without either one's work overwriting the other's.
 *
 * `usage` and `shotType` only decide what's shown and counted. Switching
 * either never clears a field: a longshot's assembled/submitted/approved are
 * hidden, not reset, and come back intact if the shot type changes back.
 */

export type ViewMode = 'overview' | 'shots' | 'sheet';
export type SideTarget = Side | 'both';

/** The last edit, so history can fold a burst of typing into one undo step. */
export interface LastEdit {
  key: string;
  at: number;
}

interface UiState {
  view: ViewMode;
  filters: Filters;
  selectedRowIds: string[];
  /** Row open in the inspector. */
  activeRowId: string | null;
  gridZoom: number;
  currentPath: string | null;
  savedRevision: number;
  lastEdit: LastEdit | null;
}

interface TrackerStore extends UiState {
  doc: TrackerDocument;
  revision: number;

  /** Replace the whole document — a file opened, a new project. Clears history. */
  setDoc: (doc: TrackerDocument, path?: string | null, options?: { dirty?: boolean }) => void;
  newProject: () => void;
  markSaved: (path: string | null) => void;
  isDirty: () => boolean;
  /**
   * Replace the document with a merge result (delta file, Elvis pull) as an
   * ordinary edit, so it stays undoable and doesn't reset the file state.
   */
  applyMergedDoc: (doc: TrackerDocument) => void;

  setHeader: (patch: Partial<TrackerDocument['header']>) => void;
  /** Share this project through a file in Elvis (a path), or stop ('' ). */
  setElvisFile: (path: string) => void;

  addRow: () => string;
  addRowsFromAssets: (assets: AssetMeta[]) => string[];
  deleteRows: (rowIds: string[]) => void;
  reorderRow: (rowId: string, beforeRowId: string | null) => void;
  assignImage: (rowId: string, asset: AssetMeta) => void;

  /** Any single field. `typing` folds consecutive keystrokes into one undo step. */
  setField: (rowId: string, path: RowFieldPath, value: unknown, options?: { typing?: boolean }) => void;
  setStage: (rowId: string, side: Side, stage: PipelineStage, done: boolean) => void;
  toggleStage: (rowId: string, side: Side, stage: PipelineStage) => void;

  addComment: (rowId: string, input: { kind: CommentKind; text: string; side: Side | null; replyTo?: string | null }) => void;
  setCommentResolved: (rowId: string, commentId: string, resolved: boolean) => void;

  batchSetStage: (rowIds: string[], side: SideTarget, stage: PipelineStage, done: boolean) => void;
  batchSetRetoucher: (rowIds: string[], side: SideTarget, retoucher: string) => void;
  batchSetField: (rowIds: string[], path: RowFieldPath, value: unknown) => void;

  setFilters: (patch: Partial<Filters>) => void;
  resetFilters: () => void;
  setView: (view: ViewMode) => void;
  setGridZoom: (zoom: number) => void;

  select: (rowIds: string[]) => void;
  toggleSelect: (rowId: string) => void;
  clearSelection: () => void;
  /** Open a row in the inspector, switching to the shots view if needed. */
  openRow: (rowId: string | null) => void;
}

const isExempt = (row: ShotRow, stage: PipelineStage) =>
  row.shotType === 'longshot' && LONGSHOT_EXEMPT_STAGES.includes(stage);

const sidesOf = (target: SideTarget): Side[] => (target === 'both' ? ['mag', 'pr'] : [target]);

const uniqueEdit = (): LastEdit => ({ key: newId(), at: Date.now() });

export const useTrackerStore = create<TrackerStore>((set, get) => {
  /** Apply a change to one row as one stamped edit. */
  const updateRow = (rowId: string, change: (row: ShotRow) => ShotRow, lastEdit: LastEdit = uniqueEdit()) =>
    set((s) => {
      const row = s.doc.rows[rowId];
      if (!row) return s;
      const next = change(row);
      if (next === row) return s;
      return { doc: { ...s.doc, rows: { ...s.doc.rows, [rowId]: next } }, revision: s.revision + 1, lastEdit };
    });

  /** Apply a change to several rows as one edit — one undo step for a batch. */
  const updateRows = (rowIds: string[], change: (row: ShotRow) => ShotRow) =>
    set((s) => {
      const rows = { ...s.doc.rows };
      let changed = false;
      for (const id of rowIds) {
        const row = rows[id];
        if (!row) continue;
        const next = change(row);
        if (next !== row) {
          rows[id] = next;
          changed = true;
        }
      }
      return changed ? { doc: { ...s.doc, rows }, revision: s.revision + 1, lastEdit: uniqueEdit() } : s;
    });

  return {
    doc: emptyDocument(),
    revision: 0,
    view: 'overview',
    filters: { ...defaultFilters },
    selectedRowIds: [],
    activeRowId: null,
    gridZoom: 1,
    currentPath: null,
    savedRevision: 0,
    lastEdit: null,

    setDoc: (doc, path = null, options = {}) => {
      resetHistory();
      set((s) => ({
        doc,
        revision: s.revision + 1,
        // A restored crash-recovery copy is *not* saved anywhere yet, so it
        // has to stay dirty — otherwise closing the app would lose it again
        // without asking.
        savedRevision: options.dirty ? s.savedRevision : s.revision + 1,
        currentPath: path,
        selectedRowIds: [],
        activeRowId: null,
        lastEdit: null,
      }));
    },

    newProject: () => get().setDoc(emptyDocument(), null),

    markSaved: (path) => set((s) => ({ currentPath: path, savedRevision: s.revision })),
    isDirty: () => get().revision !== get().savedRevision,

    applyMergedDoc: (doc) =>
      set((s) => ({
        doc,
        revision: s.revision + 1,
        lastEdit: uniqueEdit(),
        selectedRowIds: s.selectedRowIds.filter((id) => doc.rows[id]),
        activeRowId: s.activeRowId && doc.rows[s.activeRowId] ? s.activeRowId : null,
      })),

    setHeader: (patch) =>
      set((s) => ({
        doc: { ...s.doc, header: { ...s.doc.header, ...patch }, headerTime: stampNow() },
        revision: s.revision + 1,
        lastEdit: { key: `header:${Object.keys(patch).join(',')}`, at: Date.now() },
      })),

    setElvisFile: (path) =>
      set((s) =>
        s.doc.elvisFile === path ? s : { doc: { ...s.doc, elvisFile: path }, revision: s.revision + 1, lastEdit: uniqueEdit() },
      ),

    addRow: () => {
      const row = makeRow();
      set((s) => ({
        doc: { ...s.doc, rows: { ...s.doc.rows, [row.id]: row }, rowIds: [...s.doc.rowIds, row.id] },
        revision: s.revision + 1,
        lastEdit: uniqueEdit(),
      }));
      return row.id;
    },

    addRowsFromAssets: (assets) => {
      const ids: string[] = [];
      const stamp = stampNow();
      set((s) => {
        const rows = { ...s.doc.rows };
        const newAssets = { ...s.doc.assets };
        const rowIds = [...s.doc.rowIds];

        // A hash already tracked by an existing row is "already imported" —
        // the usual accident is the same folder dropped twice.
        const usedHashes = new Set<string>();
        for (const id of rowIds) {
          const h = rows[id]?.imageHash;
          if (h) usedHashes.add(h);
        }

        for (const asset of assets) {
          if (!newAssets[asset.hash]) newAssets[asset.hash] = asset;
          if (usedHashes.has(asset.hash)) continue;
          usedHashes.add(asset.hash);

          let row = touchRowField(makeRow(), 'imageHash', asset.hash, stamp);
          const guess = extractShotNumber(asset.fileName);
          if (guess) row = touchRowField(row, 'shotNum', guess, stamp);
          rows[row.id] = row;
          rowIds.push(row.id);
          ids.push(row.id);
        }
        return { doc: { ...s.doc, rows, rowIds, assets: newAssets }, revision: s.revision + 1, lastEdit: uniqueEdit() };
      });
      return ids;
    },

    deleteRows: (rowIds) => {
      if (rowIds.length === 0) return;
      const stamp = stampNow();
      set((s) => {
        const rows = { ...s.doc.rows };
        const deletedRowIds = { ...s.doc.deletedRowIds };
        for (const id of rowIds) {
          delete rows[id];
          deletedRowIds[id] = stamp;
        }
        const gone = new Set(rowIds);
        const doc = pruneUnusedAssets({ ...s.doc, rows, rowIds: s.doc.rowIds.filter((id) => !gone.has(id)), deletedRowIds });
        return {
          doc,
          revision: s.revision + 1,
          lastEdit: uniqueEdit(),
          selectedRowIds: s.selectedRowIds.filter((id) => !gone.has(id)),
          activeRowId: s.activeRowId && gone.has(s.activeRowId) ? null : s.activeRowId,
        };
      });
    },

    reorderRow: (rowId, beforeRowId) =>
      set((s) => {
        if (rowId === beforeRowId) return s;
        const without = s.doc.rowIds.filter((id) => id !== rowId);
        const at = beforeRowId ? without.indexOf(beforeRowId) : -1;
        const index = at < 0 ? without.length : at;
        const rowIds = [...without.slice(0, index), rowId, ...without.slice(index)];
        return { doc: { ...s.doc, rowIds }, revision: s.revision + 1, lastEdit: uniqueEdit() };
      }),

    assignImage: (rowId, asset) => {
      const stamp = stampNow();
      set((s) => {
        const row = s.doc.rows[rowId];
        if (!row) return s;
        const assets = s.doc.assets[asset.hash] ? s.doc.assets : { ...s.doc.assets, [asset.hash]: asset };
        let next = touchRowField(row, 'imageHash', asset.hash, stamp);
        if (!next.shotNum.trim()) {
          const guess = extractShotNumber(asset.fileName);
          if (guess) next = touchRowField(next, 'shotNum', guess, stamp);
        }
        return {
          doc: pruneUnusedAssets({ ...s.doc, assets, rows: { ...s.doc.rows, [rowId]: next } }),
          revision: s.revision + 1,
          lastEdit: uniqueEdit(),
        };
      });
    },

    setField: (rowId, path, value, options = {}) =>
      updateRow(
        rowId,
        (row) => touchRowField(row, path, value, stampNow()),
        options.typing ? { key: `type:${rowId}:${path}`, at: Date.now() } : uniqueEdit(),
      ),

    setStage: (rowId, side, stage, done) =>
      updateRow(rowId, (row) => {
        if (isExempt(row, stage) || row[side].pipeline[stage] === done) return row;
        return touchRowField(row, stagePath(side, stage), done, stampNow());
      }),

    toggleStage: (rowId, side, stage) => {
      const row = get().doc.rows[rowId];
      if (row) get().setStage(rowId, side, stage, !row[side].pipeline[stage]);
    },

    addComment: (rowId, input) => {
      const text = input.text.trim();
      if (!text) return;
      const identity = getIdentity();
      const comment: ShotComment = {
        id: newId(),
        kind: input.replyTo ? 'note' : input.kind,
        text,
        author: identity?.name ?? '',
        role: identity?.role ?? 'staff',
        at: Date.now(),
        side: input.side,
        replyTo: input.replyTo ?? null,
        resolved: false,
        resolvedBy: '',
        resolvedAt: 0,
        resolvedDevice: '',
      };
      updateRow(rowId, (row) => ({ ...row, comments: { ...row.comments, [comment.id]: comment } }));
    },

    setCommentResolved: (rowId, commentId, resolved) =>
      updateRow(rowId, (row) => {
        const c = row.comments[commentId];
        if (!c || c.resolved === resolved) return row;
        const updated: ShotComment = {
          ...c,
          resolved,
          resolvedBy: getIdentity()?.name ?? '',
          resolvedAt: Date.now(),
          resolvedDevice: getDeviceId(),
        };
        return { ...row, comments: { ...row.comments, [commentId]: updated } };
      }),

    batchSetStage: (rowIds, target, stage, done) => {
      const stamp = stampNow();
      updateRows(rowIds, (row) => {
        let next = row;
        for (const side of sidesOf(target)) {
          if (isExempt(row, stage) || next[side].pipeline[stage] === done) continue;
          next = touchRowField(next, stagePath(side, stage), done, stamp);
        }
        return next;
      });
    },

    batchSetRetoucher: (rowIds, target, retoucher) => {
      const stamp = stampNow();
      updateRows(rowIds, (row) => {
        let next = row;
        for (const side of sidesOf(target)) {
          if (next[side].retoucher === retoucher) continue;
          next = touchRowField(next, `${side}.retoucher` as RowFieldPath, retoucher, stamp);
        }
        return next;
      });
    },

    batchSetField: (rowIds, path, value) => {
      const stamp = stampNow();
      updateRows(rowIds, (row) => touchRowField(row, path, value, stamp));
    },

    setFilters: (patch) => set((s) => ({ filters: { ...s.filters, ...patch } })),
    resetFilters: () => set({ filters: { ...defaultFilters } }),
    setView: (view) => set({ view }),
    setGridZoom: (zoom) => set({ gridZoom: Math.max(0.6, Math.min(1.8, zoom)) }),

    select: (rowIds) => set({ selectedRowIds: [...rowIds] }),
    toggleSelect: (rowId) =>
      set((s) => ({
        selectedRowIds: s.selectedRowIds.includes(rowId)
          ? s.selectedRowIds.filter((id) => id !== rowId)
          : [...s.selectedRowIds, rowId],
      })),
    clearSelection: () => set({ selectedRowIds: [] }),
    openRow: (rowId) =>
      set((s) => ({
        activeRowId: rowId,
        view: rowId && s.view === 'overview' ? 'shots' : s.view,
      })),
  };
});
