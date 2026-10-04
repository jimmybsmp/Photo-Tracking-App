import { create } from 'zustand';
import { desktop } from '@/lib/desktop';
import { importImageBytes } from '@/lib/images';
import type { MergeSummary } from '@/lib/delta';
import { useTrackerStore } from '@/state/useTrackerStore';
import type { AssetMeta, TrackerDocument } from '@/state/schema';
import { applyPull, canPush, planPull, planPush } from './sync';
import { defaultElvisConfig, normalizeElvisConfig, type ElvisConfig, type ElvisRequestResult } from './types';

/**
 * Runs Elvis sync: pull every matching asset, merge, push back what differs.
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

function describe(summary: MergeSummary, pushed: number, failed: number, images: number): string {
  const parts: string[] = [];
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
    const hits = found.hits;

    // Plan against the document as it is now; download pictures for shots
    // that have none. Pictures are content-hashed, so every site that pulls
    // the same asset ends up with the same picture key.
    const plan = planPull(useTrackerStore.getState().doc, hits, config);
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

    let pushed = 0;
    let failed = 0;
    let firstFailure: ElvisRequestResult | null = null;
    if (canPush(config)) {
      const pushes = planPush(useTrackerStore.getState().doc, hits, config);
      await pool(pushes, PUSH_CONCURRENCY, async (item) => {
        const result = await bridge.elvisUpdate(config, item.assetId, item.metadata);
        if (result.ok) pushed++;
        else {
          failed++;
          firstFailure = firstFailure ?? result;
        }
      });
    }

    useSyncStore.setState({
      status: failed ? 'error' : 'idle',
      lastSyncAt: Date.now(),
      lastError: firstFailure,
      lastResult: describe(summary, pushed, failed, images.size) + (found.truncated ? ' (query matched more than 10,000 assets — narrow it)' : ''),
      assetCount: found.totalHits ?? hits.length,
      failedPushes: failed,
    });
  } catch (error) {
    useSyncStore.setState({ status: 'error', lastError: { ok: false, error: String(error) }, lastResult: 'Sync failed' });
  }
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
