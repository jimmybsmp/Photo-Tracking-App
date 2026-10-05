import { create } from 'zustand';
import { desktop, type DesktopBridge } from '@/lib/desktop';
import { importImageBytes } from '@/lib/images';
import { stampNow } from '@/lib/identity';
import { emptySummary, summaryChanged, type DeltaFile, type MergeSummary } from '@/lib/delta';
import { packDelta, unpackDelta } from '@/lib/projectFiles';
import { useTrackerStore } from '@/state/useTrackerStore';
import type { TrackerDocument } from '@/state/schema';
import {
  applyPreviews,
  factsOf,
  linkRow,
  linkedAssetIds,
  planPreviews,
  previewUrlOf,
  unlinkRow,
  versionOf,
  type FetchedPreview,
} from './link';
import {
  fileNeedsUpdate,
  mergePhotos,
  mergeShared,
  photosNeedUpdate,
  photosPathFor,
  photosPayload,
  sharedPayload,
  trackingPathProblem,
} from './sharedFile';
import {
  defaultElvisConfig,
  isConfigured,
  normalizeElvisConfig,
  type ElvisConfig,
  type ElvisFindResult,
  type ElvisHit,
  type ElvisLookupResult,
  type ElvisRequestResult,
  type ElvisTestResult,
} from './types';

/**
 * Elvis sync — the I/O around the rules in `sharedFile.ts` and `link.ts`.
 *
 * A cycle does two things, and only these:
 *   1. If the project is shared (`doc.elvisFile`), download the shared file
 *      and its photos companion, merge them, and check in a new version of
 *      either only if this site has something it lacks.
 *   2. For every shot linked to an Elvis asset, ask Elvis — by id, for just
 *      those assets — whether a new version was checked in, and fetch the
 *      new preview if so. Nothing else in Elvis is ever looked at.
 *
 * It runs on a timer (every `intervalSec`), a few seconds after any local
 * edit, and when someone clicks Sync. A cycle never overlaps another; a
 * request that arrives mid-cycle runs once more right after.
 *
 * If the network drops, nothing is lost: edits stay in the project (and in
 * crash recovery), and because each cycle compares against what Elvis
 * actually holds, everything changed in the meantime goes out on the first
 * cycle that connects.
 */

export type SyncStatus = 'unavailable' | 'not-configured' | 'idle' | 'syncing' | 'error';

interface SyncState {
  config: ElvisConfig;
  loaded: boolean;
  status: SyncStatus;
  lastSyncAt: number | null;
  lastError: ElvisRequestResult | null;
  /** Plain-language result of the last cycle. */
  lastResult: string;
  /** Linked asset ids Elvis no longer returns — deleted, or out of this account's reach. */
  missing: string[];
  /** The shared file as last seen. */
  sharedFile: { path: string; id: string; version: number | null; copies: number } | null;
}

export const useSyncStore = create<SyncState>(() => ({
  config: defaultElvisConfig,
  loaded: false,
  status: desktop() ? 'not-configured' : 'unavailable',
  lastSyncAt: null,
  lastError: null,
  lastResult: '',
  missing: [],
  sharedFile: null,
}));

/** Image decoding needs a DOM; tests swap this for a stand-in. */
export const io = { importImageBytes };

const EDIT_DEBOUNCE_MS = 4000;
const IMAGE_CONCURRENCY = 4;
/** A new version's preview can lag its check-in; keep re-fetching it this long. */
const PREVIEW_SETTLE_MS = 10 * 60_000;
/** A file this app just created may take a moment to show up in searches. */
const INDEX_GRACE_MS = 5 * 60_000;

const restingStatus = (): SyncStatus => (!desktop() ? 'unavailable' : isConfigured(useSyncStore.getState().config) ? 'idle' : 'not-configured');

/** Does this project have anything to sync? */
const hasWork = (doc: TrackerDocument) => Boolean(doc.elvisFile.trim()) || doc.rowIds.some((id) => doc.rows[id]?.elvisAssetId);

/* ------------------------------------------------------------------ *
 * Configuration
 * ------------------------------------------------------------------ */

export async function loadElvisConfig(): Promise<ElvisConfig> {
  const bridge = desktop();
  const config = normalizeElvisConfig(bridge ? await bridge.elvisGetConfig() : null);
  useSyncStore.setState({ config, loaded: true });
  useSyncStore.setState({ status: restingStatus() });
  restartTimer();
  return config;
}

export async function saveElvisConfig(config: ElvisConfig): Promise<void> {
  useSyncStore.setState({ config });
  await desktop()?.elvisSetConfig(config);
  if (useSyncStore.getState().status !== 'syncing') useSyncStore.setState({ status: restingStatus(), lastError: null });
  restartTimer();
}

export async function testConnection(config: ElvisConfig): Promise<ElvisTestResult> {
  const bridge = desktop();
  if (!bridge) return { ok: false, steps: [{ ok: false, label: 'Desktop app', detail: 'Elvis needs the desktop app.' }] };
  return bridge.elvisTest(config);
}

/* ------------------------------------------------------------------ *
 * The cycle
 * ------------------------------------------------------------------ */

async function pool<T>(items: T[], size: number, fn: (item: T) => Promise<void>) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
}

function addSummary(into: MergeSummary, from: MergeSummary) {
  into.rowsAdded += from.rowsAdded;
  into.rowsUpdated += from.rowsUpdated;
  into.rowsDeleted += from.rowsDeleted;
  into.fieldsChanged += from.fieldsChanged;
  into.commentsChanged += from.commentsChanged;
  into.headerChanged = into.headerChanged || from.headerChanged;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

let running: Promise<void> | null = null;
let rerun = false;

/** One full cycle, now. Safe to call any time; overlapping calls fold into one more run. */
export async function syncNow(): Promise<void> {
  if (running) {
    rerun = true;
    return running;
  }
  running = cycle().finally(() => {
    running = null;
    if (rerun) {
      rerun = false;
      void syncNow();
    }
  });
  return running;
}

async function cycle(): Promise<void> {
  const bridge = desktop();
  const { config } = useSyncStore.getState();
  const doc = useTrackerStore.getState().doc;
  if (!bridge || !isConfigured(config) || !hasWork(doc)) {
    useSyncStore.setState({ status: restingStatus(), missing: hasWork(doc) ? useSyncStore.getState().missing : [] });
    return;
  }

  useSyncStore.setState({ status: 'syncing' });
  const project = doc.elvisFile.trim();
  const summary = emptySummary();
  const notes: string[] = [];
  let problem: ElvisRequestResult | null = null;

  try {
    if (project) {
      const shared = await syncSharedFile(bridge, config, project);
      addSummary(summary, shared.summary);
      if (shared.photosAdded) notes.push(plural(shared.photosAdded, 'photo') + ' from other sites');
      if (shared.wrote) notes.push('shared file updated');
      problem = shared.error;
    }

    const previews = await refreshPreviews(bridge, config);
    if (previews.updated) notes.unshift(`${plural(previews.updated, 'new picture')} from Elvis`);
    if (previews.missing) notes.push(`${plural(previews.missing, 'linked asset')} not found in Elvis`);
    problem = problem ?? previews.error;

    if (summary.rowsAdded) notes.unshift(plural(summary.rowsAdded, 'new shot'));
    if (summary.rowsUpdated) notes.unshift(`${plural(summary.rowsUpdated, 'shot')} updated by others`);
    if (summary.rowsDeleted) notes.push(`${plural(summary.rowsDeleted, 'shot')} removed`);

    useSyncStore.setState({
      status: problem ? 'error' : 'idle',
      lastSyncAt: problem ? useSyncStore.getState().lastSyncAt : Date.now(),
      lastError: problem,
      lastResult: problem ? problem.error ?? 'Sync failed' : notes.length ? notes.join(' · ') : 'Up to date',
    });
  } catch (error) {
    useSyncStore.setState({ status: 'error', lastError: { ok: false, error: String(error) }, lastResult: 'Sync failed' });
  }
}

/* --- the shared file ---------------------------------------------- */

/** The last download of each copy, so an unchanged version isn't fetched every minute. */
const downloaded = new Map<string, { version: string; delta: DeltaFile }>();
/** Files this app just created, by path — Elvis may take a moment to list them. */
const justCreated = new Map<string, number>();

const hitVersion = (hit: ElvisHit): string | null => {
  const v = hit.metadata?.versionNumber ?? hit.metadata?.assetFileModified ?? hit.metadata?.fileModified;
  return v === undefined || v === null || v === '' ? null : String(v);
};

const failure = (error: string, extra: Partial<ElvisRequestResult> = {}): ElvisRequestResult => ({ ok: false, stage: 'shared file', error, ...extra });

/** Every copy of the file at `path`, downloaded and unpacked. Refuses one that isn't ours. */
async function readAll(
  bridge: DesktopBridge,
  config: ElvisConfig,
  path: string,
): Promise<{ hits: ElvisHit[]; copies: DeltaFile[] } | { error: ElvisRequestResult }> {
  const found = await bridge.elvisFindFile(config, path);
  if (!found.ok || !found.hits) return { error: { ...found, ok: false, stage: 'shared file' } };
  const copies: DeltaFile[] = [];
  for (const hit of found.hits) {
    const version = hitVersion(hit);
    const cached = downloaded.get(hit.id);
    if (version && cached && cached.version === version) {
      copies.push(cached.delta);
      continue;
    }
    if (!hit.originalUrl) {
      return { error: failure('Elvis lists the shared file but offers no download for it — this account needs permission to download originals.') };
    }
    const got = await bridge.elvisDownload(config, hit.originalUrl);
    if (!got.ok || !got.bytes) return { error: { ...got, ok: false, stage: 'shared file' } };
    try {
      const delta = unpackDelta(got.bytes);
      if (version) downloaded.set(hit.id, { version, delta });
      copies.push(delta);
    } catch {
      return { error: failure(`The file at ${path} isn't a PhotoTrack shared file, so PhotoTrack won't overwrite it. Choose another path.`) };
    }
  }
  return { hits: found.hits, copies };
}

/** Check in `payload` at `path`: a new version of the first copy, or a new file. */
async function writeFile(bridge: DesktopBridge, config: ElvisConfig, path: string, primary: ElvisHit | undefined, payload: DeltaFile) {
  if (!primary) {
    const created = justCreated.get(path);
    // Created moments ago and not searchable yet: wait rather than make a second one.
    if (created && Date.now() - created < INDEX_GRACE_MS) return { ok: true, wrote: false };
  }
  const result = await bridge.elvisUpload(config, {
    id: primary?.id,
    assetPath: path,
    fileName: path.slice(path.lastIndexOf('/') + 1),
    bytes: packDelta(payload),
    contentType: 'application/octet-stream',
  });
  if (!result.ok) return { ok: false, wrote: false, error: { ...result, stage: 'shared file' } as ElvisRequestResult };
  if (primary) downloaded.delete(primary.id);
  else justCreated.set(path, Date.now());
  return { ok: true, wrote: true };
}

interface SharedOutcome {
  summary: MergeSummary;
  photosAdded: number;
  wrote: boolean;
  error: ElvisRequestResult | null;
}

async function syncSharedFile(bridge: DesktopBridge, config: ElvisConfig, path: string): Promise<SharedOutcome> {
  const outcome: SharedOutcome = { summary: emptySummary(), photosAdded: 0, wrote: false, error: null };
  const problem = trackingPathProblem(path);
  if (problem) return { ...outcome, error: failure(problem) };
  // If someone opens another project mid-cycle, nothing from this one lands in it.
  const stillThisProject = () => useTrackerStore.getState().doc.elvisFile.trim() === path;

  const data = await readAll(bridge, config, path);
  if ('error' in data) return { ...outcome, error: data.error };
  const photosPath = photosPathFor(path);
  const photos = await readAll(bridge, config, photosPath);
  if ('error' in photos) return { ...outcome, error: photos.error };
  if (!stillThisProject()) return outcome;

  // Merge into the project as it is at this moment, never a stale snapshot.
  if (data.copies.length) {
    const merged = mergeShared(useTrackerStore.getState().doc, data.copies);
    if (summaryChanged(merged.summary)) applyRemote(merged.doc);
    outcome.summary = merged.summary;
  }
  if (photos.copies.length) {
    const merged = mergePhotos(useTrackerStore.getState().doc, photos.copies);
    if (merged.added) applyRemote(merged.doc);
    outcome.photosAdded = merged.added;
  }

  const primary = data.hits[0];
  useSyncStore.setState({
    sharedFile: primary ? { path, id: primary.id, version: Number(primary.metadata?.versionNumber) || null, copies: data.hits.length } : null,
  });

  if (!stillThisProject()) return outcome;
  const doc = useTrackerStore.getState().doc;
  if (fileNeedsUpdate(doc, data.copies[0] ?? null)) {
    const result = await writeFile(bridge, config, path, primary, sharedPayload(doc));
    if (!result.ok) return { ...outcome, error: result.error ?? null };
    outcome.wrote = result.wrote;
  }
  if (photosNeedUpdate(doc, photos.copies[0] ?? null)) {
    const result = await writeFile(bridge, config, photosPath, photos.hits[0], photosPayload(doc));
    if (!result.ok) return { ...outcome, error: result.error ?? null };
    outcome.wrote = outcome.wrote || result.wrote;
  }
  return outcome;
}

/* --- previews of linked shots -------------------------------------- */

/** A version whose preview came back unchanged: retried until it settles. */
const settling = new Map<string, { version: string; since: number }>();

async function refreshPreviews(
  bridge: DesktopBridge,
  config: ElvisConfig,
): Promise<{ updated: number; missing: number; error: ElvisRequestResult | null }> {
  const ids = linkedAssetIds(useTrackerStore.getState().doc);
  if (ids.length === 0) {
    useSyncStore.setState({ missing: [] });
    return { updated: 0, missing: 0, error: null };
  }
  const found = await bridge.elvisAssetsById(config, ids);
  if (!found.ok || !found.hits) return { updated: 0, missing: 0, error: { ...found, ok: false } };
  const hits = found.hits;
  useSyncStore.setState({ missing: found.missing ?? [] });

  const plan = planPreviews(useTrackerStore.getState().doc, hits);
  const fetched: FetchedPreview[] = [];
  await pool(plan, IMAGE_CONCURRENCY, async (item) => {
    const image = await bridge.elvisFetchImage(config, item.url);
    if (!image.ok || !image.bytes) return;
    let asset;
    try {
      asset = await io.importImageBytes(image.bytes, image.mime || 'image/jpeg', item.name);
    } catch {
      return; // an undecodable preview: try again next cycle
    }
    // Elvis can still be rendering the new version's preview: if the bytes
    // haven't changed yet, hold off recording the version for a while.
    const held = useTrackerStore.getState().doc.elvisPreviews[item.assetId];
    if (held && held.hash === asset.hash) {
      const s = settling.get(item.assetId);
      if (!s || s.version !== item.version) settling.set(item.assetId, { version: item.version, since: Date.now() });
      if (Date.now() - (settling.get(item.assetId)?.since ?? 0) < PREVIEW_SETTLE_MS) return;
    }
    settling.delete(item.assetId);
    fetched.push({ assetId: item.assetId, version: item.version, asset });
  });

  const doc = useTrackerStore.getState().doc;
  const next = applyPreviews(doc, hits, fetched);
  if (next !== doc) applyRemote(next);
  const changed = fetched.filter((f) => doc.elvisPreviews[f.assetId]?.hash !== f.asset.hash).length;
  return { updated: changed, missing: found.missing?.length ?? 0, error: null };
}

/* ------------------------------------------------------------------ *
 * Actions the UI calls
 * ------------------------------------------------------------------ */

/** Find the asset to link a shot to: a pasted id or link, or a file name. */
export async function lookupAsset(text: string): Promise<ElvisLookupResult> {
  const bridge = desktop();
  if (!bridge) return { ok: false, error: 'Elvis needs the desktop app.' };
  return bridge.elvisLookup(useSyncStore.getState().config, text);
}

/** A small picture of a candidate asset, as a URL an <img> can show. */
export async function assetThumbUrl(hit: ElvisHit): Promise<string | null> {
  const bridge = desktop();
  const url = hit.thumbnailUrl || hit.previewUrl;
  if (!bridge || !url) return null;
  const image = await bridge.elvisFetchImage(useSyncStore.getState().config, url);
  if (!image.ok || !image.bytes) return null;
  return URL.createObjectURL(new Blob([image.bytes.slice().buffer as ArrayBuffer], { type: image.mime || 'image/jpeg' }));
}

/**
 * Link a shot to an Elvis asset — the retoucher's step once their first
 * pass is in Elvis. The shot's picture becomes the asset's preview at once;
 * the link reaches the other sites through the shared file.
 */
export async function linkShot(rowId: string, hit: ElvisHit): Promise<{ ok: boolean; warning?: string }> {
  const bridge = desktop();
  if (!bridge) return { ok: false, warning: 'Elvis needs the desktop app.' };
  let preview: { asset: Awaited<ReturnType<typeof importImageBytes>>; version: string } | undefined;
  let warning: string | undefined;
  const url = previewUrlOf(hit);
  if (url) {
    const image = await bridge.elvisFetchImage(useSyncStore.getState().config, url);
    if (image.ok && image.bytes) {
      try {
        preview = { asset: await io.importImageBytes(image.bytes, image.mime || 'image/jpeg', factsOf(hit).name), version: versionOf(hit) };
      } catch {
        warning = 'Linked, but its preview couldn’t be read — the picture will update on a later sync.';
      }
    } else warning = 'Linked, but its preview couldn’t be downloaded yet — the picture will update on a later sync.';
  } else warning = 'Linked. Elvis has no preview for this asset yet; the picture will update once it does.';

  const store = useTrackerStore.getState();
  if (!store.doc.rows[rowId]) return { ok: false, warning: 'That shot no longer exists.' };
  store.applyMergedDoc(linkRow(store.doc, rowId, factsOf(hit), stampNow(), preview));
  return { ok: true, warning };
}

/** Unlink a shot from Elvis. Its picture stays. */
export function unlinkShot(rowId: string) {
  const store = useTrackerStore.getState();
  store.applyMergedDoc(unlinkRow(store.doc, rowId, stampNow()));
}

/** The shared files already in a folder — for joining a project someone else started. */
export async function listSharedFiles(folder: string): Promise<ElvisFindResult> {
  const bridge = desktop();
  if (!bridge) return { ok: false, error: 'Elvis needs the desktop app.' };
  return bridge.elvisListFiles(useSyncStore.getState().config, folder);
}

/**
 * Share this project through the file at `path` — or join the project
 * already there: if the file exists, everything in it merges into this one.
 */
export async function shareProject(path: string): Promise<void> {
  useTrackerStore.getState().setElvisFile(path.trim());
  await syncNow();
}

export function stopSharing() {
  useTrackerStore.getState().setElvisFile('');
  useSyncStore.setState({ sharedFile: null, lastError: null, status: restingStatus() });
}

/* ------------------------------------------------------------------ *
 * Triggers
 * ------------------------------------------------------------------ */

let applyingRemote = false;

/**
 * Apply merged changes as an ordinary edit — undoable, autosaved, marks the
 * project unsaved — without that change itself scheduling another sync.
 */
function applyRemote(doc: TrackerDocument) {
  applyingRemote = true;
  try {
    useTrackerStore.getState().applyMergedDoc(doc);
  } finally {
    applyingRemote = false;
  }
}

let timer: ReturnType<typeof setInterval> | null = null;
let editTimer: ReturnType<typeof setTimeout> | null = null;

function restartTimer() {
  if (timer) clearInterval(timer);
  timer = null;
  const { config } = useSyncStore.getState();
  if (!desktop() || !config.enabled || !isConfigured(config)) return;
  timer = setInterval(() => void syncNow(), config.intervalSec * 1000);
}

/** Start background sync for the app's lifetime. Returns a stop function. */
export function startAutoSync(): () => void {
  if (!desktop()) return () => undefined;

  const unsubscribe = useTrackerStore.subscribe((state, prev) => {
    if (applyingRemote || state.revision === prev.revision || state.doc === prev.doc) return;
    // Another project opened: forget what was shown for the last one.
    if (state.doc.elvisFile !== prev.doc.elvisFile && useSyncStore.getState().status !== 'syncing') {
      useSyncStore.setState({ sharedFile: null, missing: [], lastError: null, status: restingStatus() });
    }
    const { config } = useSyncStore.getState();
    if (!config.enabled || !hasWork(state.doc)) return;
    if (editTimer) clearTimeout(editTimer);
    editTimer = setTimeout(() => void syncNow(), EDIT_DEBOUNCE_MS);
  });

  void loadElvisConfig().then((config) => {
    if (config.enabled && hasWork(useTrackerStore.getState().doc)) void syncNow();
  });

  return () => {
    unsubscribe();
    if (timer) clearInterval(timer);
    if (editTimer) clearTimeout(editTimer);
  };
}
