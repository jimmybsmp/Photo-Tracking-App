import { create } from 'zustand';
import { desktop } from '@/lib/desktop';
import { importImageBytes } from '@/lib/images';
import { emptySummary, summaryChanged, type DeltaFile, type MergeSummary } from '@/lib/delta';
import { packDelta, unpackDelta } from '@/lib/projectFiles';
import { useTrackerStore } from '@/state/useTrackerStore';
import type { AssetMeta, TrackerDocument } from '@/state/schema';
import { applyPull, canPush, planPull, planPush } from './sync';
import { fileNeedsUpdate, isTrackingFileHit, mergeShared, sharedPayload, trackingPathProblem } from './sharedFile';
import { defaultElvisConfig, normalizeElvisConfig, type ElvisConfig, type ElvisHit, type ElvisRequestResult } from './types';
import type { DesktopBridge } from '@/lib/desktop';

/**
 * Runs Elvis sync: pull every matching asset, merge, push back what differs.
 *
 * With the shared tracking file (the default), a cycle is: read the photos
 * (new shots, pictures), then download the shared file, merge it, and check
 * in a new version if this site has anything it lacks. With a record field
 * instead, the shared state rides on each photo's metadata.
 *
 * It runs on a timer (every `intervalSec`), a few seconds after any local
 * edit, and when someone clicks Sync. A cycle never overlaps another; a
 * request that arrives mid-cycle runs once more right after.
 *
 * If the network drops, nothing is lost: edits stay in the project (and in
 * crash recovery), and because the next pull compares against what Elvis
 * actually holds, everything changed in the meantime goes out on the first
 * cycle that connects.
 */

export type SyncStatus = 'unavailable' | 'not-configured' | 'not-linked' | 'idle' | 'syncing' | 'error';

interface SyncState {
  config: ElvisConfig;
  loaded: boolean;
  status: SyncStatus;
  lastSyncAt: number | null;
  lastError: ElvisRequestResult | null;
  /** Plain-language result of the last cycle. */
  lastResult: string;
  /** Assets the query matched last time. */
  assetCount: number;
  /** Writes that failed last cycle, retried next cycle. */
  failedPushes: number;
  /** The shared tracking file as last seen: its Elvis id and version. */
  trackingFile: { id: string; version: number | null; copies: number } | null;
}

export const useSyncStore = create<SyncState>(() => ({
  config: defaultElvisConfig,
  loaded: false,
  status: desktop() ? 'not-configured' : 'unavailable',
  lastSyncAt: null,
  lastError: null,
  lastResult: '',
  assetCount: 0,
  failedPushes: 0,
  trackingFile: null,
}));

const EDIT_DEBOUNCE_MS = 4000;
const IMAGE_CONCURRENCY = 4;
const PUSH_CONCURRENCY = 3;

const configured = (c: ElvisConfig) => Boolean(c.endpoint.trim()) && (c.authMode !== 'login' || Boolean(c.username.trim()));

function idleStatus(): SyncStatus {
  if (!desktop()) return 'unavailable';
  const { config } = useSyncStore.getState();
  if (!configured(config)) return 'not-configured';
  return useTrackerStore.getState().doc.elvisLinked ? 'idle' : 'not-linked';
}

export async function loadElvisConfig(): Promise<ElvisConfig> {
  const bridge = desktop();
  const config = normalizeElvisConfig(bridge ? await bridge.elvisGetConfig() : null);
  useSyncStore.setState({ config, loaded: true });
  useSyncStore.setState({ status: idleStatus() });
  restartTimer();
  return config;
}

export async function saveElvisConfig(config: ElvisConfig): Promise<void> {
  useSyncStore.setState({ config });
  await desktop()?.elvisSetConfig(config);
  if (useSyncStore.getState().status !== 'syncing') useSyncStore.setState({ status: idleStatus() });
  restartTimer();
}

async function pool<T>(items: T[], size: number, fn: (item: T) => Promise<void>) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
}

function describe(summary: MergeSummary, pushed: number, failed: number, images: number, file: SharedFileOutcome | null): string {
  const parts: string[] = [];
  if (file?.created) parts.push('shared file created');
  else if (file?.checkedIn) parts.push('shared file updated');
  if (summary.rowsAdded) parts.push(`${summary.rowsAdded} new shot${summary.rowsAdded === 1 ? '' : 's'}`);
  if (summary.rowsUpdated) parts.push(`${summary.rowsUpdated} updated`);
  if (images) parts.push(`${images} photo${images === 1 ? '' : 's'} downloaded`);
  if (pushed) parts.push(`${pushed} sent to Elvis`);
  if (failed) parts.push(`${failed} could not be sent`);
  return parts.length ? parts.join(', ') : 'Everything already up to date';
}

let running: Promise<void> | null = null;
let rerun = false;

/**
 * One full cycle. `link` is the explicit "pull this shoot into this project"
 * from the panel; automatic cycles only touch projects already linked.
 */
export async function syncNow(options: { link?: boolean } = {}): Promise<void> {
  if (running) {
    rerun = true;
    return running;
  }
  running = cycle(options).finally(() => {
    running = null;
    if (rerun) {
      rerun = false;
      void syncNow();
    }
  });
  return running;
}

async function cycle({ link = false }: { link?: boolean }): Promise<void> {
  const bridge = desktop();
  const { config } = useSyncStore.getState();
  if (!bridge || !configured(config)) {
    useSyncStore.setState({ status: idleStatus() });
    return;
  }
  if (!link && !useTrackerStore.getState().doc.elvisLinked) {
    useSyncStore.setState({ status: 'not-linked' });
    return;
  }

  useSyncStore.setState({ status: 'syncing' });
  try {
    const found = await bridge.elvisSearch(config);
    if (!found.ok || !found.hits) {
      useSyncStore.setState({ status: 'error', lastError: found, lastResult: 'Could not reach Elvis' });
      return;
    }
    // The tracking file is not a photo, even when the photo query reaches its folder.
    const fileMode = config.sharedStore === 'file';
    const hits = found.hits.filter((hit) => !(fileMode && isTrackingFileHit(hit, config)));
    const photoConfig = fileMode ? { ...config, recordField: '' } : config;

    // Plan against the document as it is now; download pictures for shots
    // that have none. Pictures are content-hashed, so every site that pulls
    // the same asset ends up with the same picture key.
    const plan = planPull(useTrackerStore.getState().doc, hits, photoConfig);
    const images = new Map<string, AssetMeta>();
    await pool(
      plan.filter((p) => p.imageUrl),
      IMAGE_CONCURRENCY,
      async (item) => {
        const result = await bridge.elvisFetchImage(config, item.imageUrl as string);
        if (!result.ok || !result.bytes) return;
        try {
          images.set(item.assetId, await importImageBytes(result.bytes, result.mime || 'image/jpeg', item.imageName));
        } catch {
          // An undecodable preview (a RAW-only asset, say) just stays without a picture.
        }
      },
    );

    // Merge into the document as it is at *this* moment — edits made while
    // the network was busy are merged, not overwritten.
    const { doc, summary } = applyPull(useTrackerStore.getState().doc, plan, images);
    if (doc !== useTrackerStore.getState().doc) applyRemote(doc);

    let file: SharedFileOutcome | null = null;
    if (fileMode) {
      file = await syncSharedFile(bridge, config);
      addSummary(summary, file.summary);
    }

    let pushed = 0;
    let failed = 0;
    let firstFailure: ElvisRequestResult | null = file?.error ?? null;
    if (canPush(photoConfig)) {
      const pushes = planPush(useTrackerStore.getState().doc, hits, photoConfig);
      await pool(pushes, PUSH_CONCURRENCY, async (item) => {
        const result = await bridge.elvisUpdate(config, item.assetId, item.metadata);
        if (result.ok) pushed++;
        else {
          failed++;
          firstFailure = firstFailure ?? result;
        }
      });
    }

    const fileFailed = Boolean(file?.error);
    useSyncStore.setState({
      status: failed || fileFailed ? 'error' : 'idle',
      lastSyncAt: Date.now(),
      lastError: firstFailure,
      lastResult: fileFailed
        ? `Shared file: ${file?.error?.error ?? 'failed'}`
        : describe(summary, pushed, failed, images.size, file) + (found.truncated ? ' (query matched more than 10,000 assets — narrow it)' : ''),
      // The tracking file is not one of the shoot's assets.
      assetCount: (found.totalHits ?? found.hits.length) - (found.hits.length - hits.length),
      failedPushes: failed,
    });
  } catch (error) {
    useSyncStore.setState({ status: 'error', lastError: { ok: false, error: String(error) }, lastResult: 'Sync failed' });
  }
}

/* ------------------------------------------------------------------ *
 * The shared tracking file
 * ------------------------------------------------------------------ */

interface SharedFileOutcome {
  summary: MergeSummary;
  created: boolean;
  checkedIn: boolean;
  error: ElvisRequestResult | null;
}

function addSummary(into: MergeSummary, from: MergeSummary) {
  into.rowsAdded += from.rowsAdded;
  into.rowsUpdated += from.rowsUpdated;
  into.rowsDeleted += from.rowsDeleted;
  into.fieldsChanged += from.fieldsChanged;
  into.commentsChanged += from.commentsChanged;
  into.headerChanged = into.headerChanged || from.headerChanged;
}

/** The last download of each copy, so an unchanged version isn't fetched every minute. */
const downloaded = new Map<string, { version: string; delta: DeltaFile }>();
/** A file this app just created — Elvis may take a moment to list it in searches. */
let justCreated: { path: string; id: string; at: number } | null = null;
const INDEX_GRACE_MS = 5 * 60_000;

const versionOf = (hit: ElvisHit): string | null => {
  const m = hit.metadata ?? {};
  const v = m.versionNumber ?? m.assetFileModified ?? m.fileModified;
  const raw = v && typeof v === 'object' ? (v as Record<string, unknown>).value : v;
  return raw === undefined || raw === null || raw === '' ? null : String(raw);
};

const fileFailure = (error: string, extra: Partial<ElvisRequestResult> = {}): ElvisRequestResult => ({
  ok: false,
  stage: 'shared file',
  error,
  ...extra,
});

async function readCopy(bridge: DesktopBridge, config: ElvisConfig, hit: ElvisHit): Promise<DeltaFile | ElvisRequestResult> {
  const version = versionOf(hit);
  const cached = downloaded.get(hit.id);
  if (version && cached && cached.version === version) return cached.delta;
  if (!hit.originalUrl) {
    return fileFailure('Elvis lists the shared file but offers no download for it — this account needs permission to download originals.');
  }
  const got = await bridge.elvisDownload(config, hit.originalUrl);
  if (!got.ok || !got.bytes) return { ...got, ok: false, stage: 'shared file' };
  try {
    const delta = unpackDelta(got.bytes);
    if (version) downloaded.set(hit.id, { version, delta });
    return delta;
  } catch {
    return fileFailure(
      `The file at ${config.trackingFile} isn't a PhotoTrack tracking file, so PhotoTrack won't overwrite it. Choose another path.`,
    );
  }
}

/**
 * Download every copy of the file, merge, and check in a new version if this
 * site has anything the file lacks. Never writes over a file it couldn't read.
 */
async function syncSharedFile(bridge: DesktopBridge, config: ElvisConfig): Promise<SharedFileOutcome> {
  const outcome: SharedFileOutcome = { summary: emptySummary(), created: false, checkedIn: false, error: null };
  const path = config.trackingFile.trim();
  const problem = trackingPathProblem(path);
  if (problem) {
    outcome.error = fileFailure(problem);
    return outcome;
  }

  const found = await bridge.elvisFindFile(config, path);
  if (!found.ok || !found.hits) {
    outcome.error = { ...found, ok: false, stage: 'shared file' };
    return outcome;
  }
  const hits = found.hits;

  const copies: DeltaFile[] = [];
  for (const hit of hits) {
    const copy = await readCopy(bridge, config, hit);
    if ('kind' in copy) copies.push(copy);
    else {
      outcome.error = copy;
      return outcome;
    }
  }

  // Merge into the project as it is at this moment, never a stale snapshot.
  if (copies.length) {
    const merged = mergeShared(useTrackerStore.getState().doc, copies);
    if (summaryChanged(merged.summary)) applyRemote(merged.doc);
    outcome.summary = merged.summary;
  }

  const primary = hits[0];
  useSyncStore.setState({
    trackingFile: primary ? { id: primary.id, version: Number(primary.metadata?.versionNumber) || null, copies: hits.length } : null,
  });

  if (!primary && justCreated && justCreated.path === path && Date.now() - justCreated.at < INDEX_GRACE_MS) {
    // Created moments ago and not searchable yet: wait rather than make a second one.
    return outcome;
  }

  const doc = useTrackerStore.getState().doc;
  if (!fileNeedsUpdate(doc, copies[0] ?? null)) return outcome;

  const payload = sharedPayload(doc);
  const result = await bridge.elvisUpload(config, {
    id: primary?.id,
    assetPath: path,
    fileName: path.slice(path.lastIndexOf('/') + 1),
    bytes: packDelta(payload),
    contentType: 'application/octet-stream',
  });
  if (!result.ok) {
    outcome.error = { ...result, stage: 'shared file' };
    return outcome;
  }
  if (primary) {
    outcome.checkedIn = true;
    downloaded.delete(primary.id);
  } else {
    outcome.created = true;
    justCreated = { path, id: result.id ?? '', at: Date.now() };
  }
  return outcome;
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
  if (!desktop() || !config.enabled || !configured(config)) return;
  timer = setInterval(() => void syncNow(), config.intervalSec * 1000);
}

/** Start background sync for the app's lifetime. Returns a stop function. */
export function startAutoSync(): () => void {
  if (!desktop()) return () => undefined;

  const unsubscribe = useTrackerStore.subscribe((state, prev) => {
    // Opening or unlinking a project changes what the chip should say — but
    // never mid-cycle, where linking is part of the sync that's running.
    if (state.doc.elvisLinked !== prev.doc.elvisLinked && useSyncStore.getState().status !== 'syncing') {
      useSyncStore.setState({ status: idleStatus() });
    }
    if (applyingRemote || state.revision === prev.revision || state.doc === prev.doc) return;
    const { config } = useSyncStore.getState();
    if (!config.enabled || !state.doc.elvisLinked) return;
    if (editTimer) clearTimeout(editTimer);
    editTimer = setTimeout(() => void syncNow(), EDIT_DEBOUNCE_MS);
  });

  void loadElvisConfig().then((config) => {
    if (config.enabled && useTrackerStore.getState().doc.elvisLinked) void syncNow();
  });

  return () => {
    unsubscribe();
    if (timer) clearInterval(timer);
    if (editTimer) clearTimeout(editTimer);
  };
}
