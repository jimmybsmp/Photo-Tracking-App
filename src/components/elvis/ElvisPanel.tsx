import { useEffect, useRef, useState, type ReactNode } from 'react';
import { isDesktop } from '@/lib/desktop';
import {
  listSharedFiles,
  saveElvisConfig,
  shareProject,
  stopSharing,
  syncNow,
  testConnection,
  useSyncStore,
} from '@/lib/elvis/autoSync';
import { TRACKING_FOLDER, suggestTrackingPath, trackingPathProblem } from '@/lib/elvis/sharedFile';
import { isConfigured, type ElvisConfig, type ElvisHit, type ElvisTestStep } from '@/lib/elvis/types';
import { timeAgo } from '@/lib/format';
import { useTrackerStore } from '@/state/useTrackerStore';
import { useNow } from '@/components/ui/hooks';
import { Modal } from '@/components/ui/Modal';

/**
 * Elvis, in two parts:
 *
 *   1. This computer's connection — server and login, kept in the desktop
 *      app's own encrypted config.
 *   2. Sharing this project — the one shared file every site syncs through.
 *      Start it here, or join one another site already started.
 *
 * Linking a shot to its Elvis asset happens on the shot itself (its panel's
 * Elvis section), by the retoucher, once the first pass is in Elvis.
 */
export function ElvisPanel({ onClose }: { onClose: () => void }) {
  if (!isDesktop()) {
    return (
      <Modal onClose={onClose} title="WoodWing Elvis">
        <p>
          Elvis needs the desktop app — a page opened in a browser can't sign in to your DAM. Everything else works the
          same here, and File → Export / Import changes carries work between machines.
        </p>
      </Modal>
    );
  }
  return (
    <Modal onClose={onClose} title="WoodWing Elvis" wide>
      <ConnectionSection />
      <SharingSection />
      <p className="muted small elvis-footnote">
        <strong>Linking shots:</strong> once a retoucher's first pass is in Elvis, they open the shot and, under Elvis,
        paste the asset's id or link (or find it by name). From then on the shot shows that asset's latest preview.
        Nothing else in Elvis is read, and PhotoTrack never changes a photo there.
      </p>
    </Modal>
  );
}

/* ------------------------------------------------------------------ */

function ConnectionSection() {
  const stored = useSyncStore((s) => s.config);
  const [config, setConfig] = useState<ElvisConfig>(stored);
  const [steps, setSteps] = useState<ElvisTestStep[]>([]);
  const [testing, setTesting] = useState(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef(config);
  latest.current = config;

  // The stored config can arrive after the panel opens (first launch).
  const loaded = useSyncStore((s) => s.loaded);
  useEffect(() => {
    if (loaded && !saveTimer.current) setConfig(useSyncStore.getState().config);
  }, [loaded]);

  // Saving is debounced: every keystroke in the password box shouldn't
  // rewrite the encrypted config file and drop the Elvis session.
  const update = (patch: Partial<ElvisConfig>) => {
    const next = { ...latest.current, ...patch };
    setConfig(next);
    setSteps([]);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      saveTimer.current = null;
      void saveElvisConfig(next);
    }, 400);
  };
  // Closing the panel mid-debounce still saves the last edit.
  useEffect(
    () => () => {
      if (saveTimer.current) {
        clearTimeout(saveTimer.current);
        void saveElvisConfig(latest.current);
      }
    },
    [],
  );

  const test = async () => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = null;
    await saveElvisConfig(latest.current);
    setTesting(true);
    setSteps([]);
    try {
      setSteps((await testConnection(latest.current)).steps);
    } finally {
      setTesting(false);
    }
  };

  return (
    <Section n={1} title="This computer's connection">
      <label className="field-label">
        <span>Server address</span>
        <input
          className="field"
          value={config.endpoint}
          placeholder="https://dam.yourcompany.com — the address you use in a browser"
          onChange={(e) => update({ endpoint: e.target.value })}
        />
      </label>
      <div className="form-grid">
        <label className="field-label">
          <span>Sign in with</span>
          <select className="field field-select" value={config.authMode} onChange={(e) => update({ authMode: e.target.value as ElvisConfig['authMode'] })}>
            <option value="login">Username &amp; password</option>
            <option value="apikey">Bearer token (advanced)</option>
            <option value="basic">HTTP Basic (advanced)</option>
            <option value="none">Nothing (advanced)</option>
          </select>
        </label>
        {config.authMode === 'apikey' ? (
          <label className="field-label">
            <span>Bearer token</span>
            <input className="field" type="password" value={config.apiKey} onChange={(e) => update({ apiKey: e.target.value })} />
          </label>
        ) : config.authMode !== 'none' ? (
          <>
            <label className="field-label">
              <span>Username</span>
              <input className="field" value={config.username} autoComplete="username" onChange={(e) => update({ username: e.target.value })} />
            </label>
            <label className="field-label">
              <span>Password</span>
              <input
                className="field"
                type="password"
                value={config.password}
                autoComplete="current-password"
                onChange={(e) => update({ password: e.target.value })}
              />
            </label>
          </>
        ) : null}
      </div>
      <div className="row-gap">
        <button type="button" className="btn" onClick={() => void test()} disabled={testing || !config.endpoint.trim()}>
          {testing ? 'Testing…' : 'Test connection'}
        </button>
        <label className="check-row small">
          <input type="checkbox" checked={config.enabled} onChange={(e) => update({ enabled: e.target.checked })} />
          Sync automatically every
          <select className="field field-select field-sm" value={config.intervalSec} onChange={(e) => update({ intervalSec: Number(e.target.value) })}>
            <option value={30}>30 seconds</option>
            <option value={60}>minute</option>
            <option value={300}>5 minutes</option>
            <option value={900}>15 minutes</option>
          </select>
          and soon after each change
        </label>
      </div>
      {steps.length > 0 && (
        <ol className="elvis-steps">
          {steps.map((step) => (
            <li key={step.label} className={step.ok ? 'elvis-step-ok' : 'elvis-step-fail'}>
              <strong>
                {step.ok ? '✓' : '✗'} {step.label}
              </strong>
              {step.detail && <span className="elvis-step-detail">{step.detail}</span>}
              {step.url && <code className="elvis-step-url">{step.url}</code>}
              {step.hint && <span className="elvis-step-hint">{step.hint}</span>}
            </li>
          ))}
        </ol>
      )}
    </Section>
  );
}

/* ------------------------------------------------------------------ */

function SharingSection() {
  const connected = useSyncStore((s) => isConfigured(s.config));
  const path = useTrackerStore((s) => s.doc.elvisFile);
  return (
    <Section n={2} title="Share this project">
      {!connected ? (
        <p className="muted small">Fill in the connection above first.</p>
      ) : path ? (
        <SharedStatus path={path} />
      ) : (
        <StartOrJoin />
      )}
    </Section>
  );
}

function SharedStatus({ path }: { path: string }) {
  const status = useSyncStore((s) => s.status);
  const lastResult = useSyncStore((s) => s.lastResult);
  const lastSyncAt = useSyncStore((s) => s.lastSyncAt);
  const error = useSyncStore((s) => s.lastError);
  const fileVersion = useSyncStore((s) => (s.sharedFile?.path === path ? s.sharedFile.version : null));
  const copies = useSyncStore((s) => (s.sharedFile?.path === path ? s.sharedFile.copies : 0));
  useNow(15_000);

  const tone = status === 'error' ? 'bad' : status === 'syncing' ? 'busy' : 'ok';
  return (
    <>
      <div className={`status-banner status-${tone}`}>
        <strong>
          {status === 'syncing'
            ? 'Syncing…'
            : status === 'error'
              ? 'Last sync had a problem — your work is safe here and goes out on the next sync'
              : lastSyncAt
                ? `Synced ${timeAgo(lastSyncAt)}`
                : 'Shared'}
        </strong>
        {status !== 'error' && lastResult && <span>{lastResult}</span>}
        {status === 'error' && error?.error && <span className="elvis-step-detail">{error.error}</span>}
        {status === 'error' && error?.url && <code className="elvis-step-url">{error.url}</code>}
        {status === 'error' && error?.hint && <span className="elvis-step-hint">{error.hint}</span>}
      </div>
      <p className="small">
        Shared through <code>{path}</code>
        {fileVersion ? <span className="muted"> · version {fileVersion}</span> : null}
      </p>
      {copies > 1 && (
        <p className="notice small">
          There are {copies} files at this path in Elvis (two sites started sharing at the same moment). PhotoTrack reads
          them all and keeps the first up to date; the others can be deleted in Elvis.
        </p>
      )}
      <p className="muted small">Every site on this shoot uses this same file. Each change is saved as a new version of it in Elvis.</p>
      <div className="row-gap">
        <button type="button" className="btn btn-primary" onClick={() => void syncNow()} disabled={status === 'syncing'}>
          {status === 'syncing' ? 'Syncing…' : 'Sync now'}
        </button>
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => {
            if (confirm('Stop sharing this project? Everything stays here, and the shared file stays in Elvis for the other sites.')) stopSharing();
          }}
        >
          Stop sharing
        </button>
      </div>
    </>
  );
}

function StartOrJoin() {
  const event = useTrackerStore((s) => s.doc.header.event);
  const name = useTrackerStore((s) => s.doc.header.name);
  const shotCount = useTrackerStore((s) => s.doc.rowIds.length);
  const [path, setPath] = useState(() => suggestTrackingPath({ event, name }));
  const [folder, setFolder] = useState(TRACKING_FOLDER);
  const [files, setFiles] = useState<ElvisHit[] | null>(null);
  const [listing, setListing] = useState(false);
  const [listError, setListError] = useState('');
  const [busy, setBusy] = useState(false);
  const problem = trackingPathProblem(path);

  const share = async (target: string, joining: boolean) => {
    if (joining && shotCount > 0) {
      const ok = confirm(
        `Join “${target}”? Its shots will be added to the ${shotCount} already in this project. ` +
          'To keep them apart, choose Cancel, then File → New project, and join from there.',
      );
      if (!ok) return;
    }
    setBusy(true);
    try {
      await shareProject(target);
    } finally {
      setBusy(false);
    }
  };

  const list = async () => {
    setListing(true);
    setListError('');
    try {
      const result = await listSharedFiles(folder);
      if (result.ok) setFiles(result.hits ?? []);
      else {
        setFiles(null);
        setListError(result.error ?? 'Could not list that folder.');
      }
    } finally {
      setListing(false);
    }
  };

  return (
    <div className="share-grid">
      <div className="share-card">
        <h4>Start sharing this project</h4>
        <p className="muted small">
          Make a folder for PhotoTrack in Elvis first — outside the photo folders, e.g. <code>{TRACKING_FOLDER}</code>. Then
          choose the file name for this shoot:
        </p>
        <input className="field" value={path} onChange={(e) => setPath(e.target.value)} placeholder={`${TRACKING_FOLDER}/Gala 2026.ptdelta`} />
        {problem && <p className="field-error small">{problem}</p>}
        <button type="button" className="btn btn-primary" disabled={Boolean(problem) || busy} onClick={() => void share(path.trim(), false)}>
          {busy ? 'Sharing…' : 'Share'}
        </button>
      </div>

      <div className="share-card">
        <h4>Join a project another site started</h4>
        <div className="row-gap">
          <input className="field" value={folder} onChange={(e) => setFolder(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void list()} />
          <button type="button" className="btn" onClick={() => void list()} disabled={listing}>
            {listing ? 'Looking…' : 'Show shared projects'}
          </button>
        </div>
        {listError && <p className="field-error small">{listError}</p>}
        {files && files.length === 0 && <p className="muted small">No shared projects in {folder} yet.</p>}
        {files && files.length > 0 && (
          <ul className="file-list">
            {files.map((f) => {
              const target = `${folder.trim().replace(/\/+$/, '')}/${f.name}`;
              return (
                <li key={f.id}>
                  <span className="file-name">{String(f.name).replace(/\.ptdelta$/i, '')}</span>
                  <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => void share(target, true)}>
                    Join
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

function Section({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <section className="elvis-section">
      <h3>
        <span className="step-num">{n}</span> {title}
      </h3>
      {children}
    </section>
  );
}
