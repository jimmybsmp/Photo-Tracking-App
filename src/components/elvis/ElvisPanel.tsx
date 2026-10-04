import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { desktop, isDesktop } from '@/lib/desktop';
import { saveElvisConfig, syncNow, useSyncStore } from '@/lib/elvis/autoSync';
import { canPush } from '@/lib/elvis/sync';
import {
  MIRROR_LABELS,
  type ElvisConfig,
  type ElvisMirrorMap,
  type ElvisSampleField,
  type ElvisTestStep,
} from '@/lib/elvis/types';
import { timeAgo } from '@/lib/format';
import { useTrackerStore } from '@/state/useTrackerStore';
import { useNow } from '@/components/ui/hooks';

const SUGGESTED_RECORD_FIELD = 'cf_photoTrack';

/**
 * WoodWing Elvis: connection, which assets make up the shoot, and where
 * tracking data lives on them. The field lists come from the server itself
 * (Test connection reads a few assets), so mapping is picking what exists
 * rather than guessing names — the reason an earlier pull came back blank.
 */
export function ElvisPanel({ onClose }: { onClose: () => void }) {
  const stored = useSyncStore((s) => s.config);
  const status = useSyncStore((s) => s.status);
  const lastResult = useSyncStore((s) => s.lastResult);
  const lastError = useSyncStore((s) => s.lastError);
  const lastSyncAt = useSyncStore((s) => s.lastSyncAt);
  const assetCount = useSyncStore((s) => s.assetCount);
  const linked = useTrackerStore((s) => s.doc.elvisLinked);
  const shotCount = useTrackerStore((s) => s.doc.rowIds.length);
  const [config, setConfig] = useState<ElvisConfig>(stored);
  const [steps, setSteps] = useState<ElvisTestStep[]>([]);
  const [fields, setFields] = useState<ElvisSampleField[]>([]);
  const [testing, setTesting] = useState(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef(config);
  latest.current = config;
  useNow(15_000);

  // Saving is debounced: every keystroke in the password box shouldn't
  // rewrite the encrypted config file and drop the Elvis session.
  const update = (patch: Partial<ElvisConfig>) => {
    const next = { ...config, ...patch };
    setConfig(next);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => void saveElvisConfig(next), 400);
  };
  const flush = async () => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    await saveElvisConfig(config);
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

  const sampleOf = useMemo(() => new Map(fields.map((f) => [f.name, f.sample])), [fields]);

  if (!isDesktop()) {
    return (
      <Modal onClose={onClose} title="WoodWing Elvis">
        <p>
          Elvis sync needs the desktop app — a page opened in a browser can't log in to your DAM or get past its
          security rules. Everything else works the same here, and delta files carry changes between machines.
        </p>
      </Modal>
    );
  }

  const test = async () => {
    await flush();
    setTesting(true);
    setSteps([]);
    try {
      const result = await desktop()!.elvisTest(config);
      setSteps(result.steps);
      setFields(result.sampleFields ?? []);
    } finally {
      setTesting(false);
    }
  };

  const pull = async () => {
    await flush();
    await syncNow({ link: true });
  };

  const fieldInput = (value: string, onChange: (v: string) => void, placeholder: string) => (
    <>
      <input className="field" list="elvis-fields" value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value.trim())} />
      {value && sampleOf.has(value) && <span className="muted small field-sample">e.g. {sampleOf.get(value)}</span>}
      {value && fields.length > 0 && !sampleOf.has(value) && <span className="muted small field-sample">Not set on the sampled assets yet</span>}
    </>
  );

  return (
    <Modal onClose={onClose} title="WoodWing Elvis" wide>
      <StatusBanner
        status={status}
        lastResult={lastResult}
        lastSyncAt={lastSyncAt}
        assetCount={assetCount}
        error={lastError}
      />

      <Section n={1} title="Connect">
        <label className="field-label">
          <span>Server address</span>
          <input className="field" value={config.endpoint} placeholder="https://dam.yourcompany.com — the address you use in a browser" onChange={(e) => update({ endpoint: e.target.value })} />
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
                <input className="field" value={config.username} onChange={(e) => update({ username: e.target.value })} />
              </label>
              <label className="field-label">
                <span>Password</span>
                <input className="field" type="password" value={config.password} onChange={(e) => update({ password: e.target.value })} />
              </label>
            </>
          ) : null}
        </div>
      </Section>

      <Section n={2} title="Which assets make up this shoot">
        <label className="field-label">
          <span>Elvis query</span>
          <input
            className="field"
            value={config.query}
            placeholder={'e.g. ancestorPaths:"/Shoots/2026/Gala"   — empty means every asset you can see'}
            onChange={(e) => update({ query: e.target.value })}
          />
        </label>
        <p className="muted small">
          Usually the shoot's folder. Every asset this matches becomes a shot; new ones appear on each sync.
        </p>
        <div className="row-gap">
          <button className="btn" onClick={() => void test()} disabled={testing || !config.endpoint}>
            {testing ? 'Testing…' : 'Test connection'}
          </button>
          {fields.length > 0 && <span className="muted small">Found {fields.length} fields on your assets — they're listed in the boxes below.</span>}
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

      <Section n={3} title="Shared PhotoTrack record (recommended)">
        <p className="small">
          One multi-line text field on each asset where PhotoTrack keeps the shot's full tracking state — both
          properties, who marked each stage and when, and every note and concern. With it, sites anywhere merge each
          other's work field by field and nobody's changes overwrite anyone else's.{' '}
          <strong>An Elvis administrator has to create this field once</strong> (multi-line text, editable by the
          sync account).
        </p>
        <label className="field-label">
          <span>Record field name</span>
          {fieldInput(config.recordField, (v) => update({ recordField: v }), SUGGESTED_RECORD_FIELD)}
        </label>
        {!config.recordField && (
          <div className="notice">
            Without it, only the plain fields below are shared — no who/when, and notes and concerns stay on this
            computer.{' '}
            <button className="link-btn" onClick={() => update({ recordField: SUGGESTED_RECORD_FIELD })}>
              Use “{SUGGESTED_RECORD_FIELD}”
            </button>
          </div>
        )}
      </Section>

      <Section n={4} title="Plain fields (optional)">
        <p className="muted small">
          For people working in Elvis itself. Filled in from PhotoTrack on every sync, and read once when a shot first
          arrives with values but no record. Leave a box empty to skip that field.
        </p>
        <div className="form-grid">
          {(Object.keys(MIRROR_LABELS) as Array<keyof ElvisMirrorMap>).map((key) => (
            <label className="field-label" key={key}>
              <span>{MIRROR_LABELS[key]}</span>
              {fieldInput(config.mirror[key], (v) => update({ mirror: { ...config.mirror, [key]: v } }), 'Not used')}
            </label>
          ))}
        </div>
      </Section>

      <Section n={5} title="Sync">
        <label className="check-row">
          <input type="checkbox" checked={config.enabled} onChange={(e) => update({ enabled: e.target.checked })} />
          Keep linked projects in sync automatically, every
          <select className="field field-select field-sm" value={config.intervalSec} onChange={(e) => update({ intervalSec: Number(e.target.value) })}>
            <option value={30}>30 seconds</option>
            <option value={60}>minute</option>
            <option value={300}>5 minutes</option>
            <option value={900}>15 minutes</option>
          </select>
          and a few seconds after each change
        </label>
        {!canPush(config) && (
          <p className="notice">Nothing will be written back to Elvis until a record field or a plain field is set.</p>
        )}
        <div className="row-gap">
          <button className="btn btn-primary" onClick={() => void pull()} disabled={status === 'syncing' || !config.endpoint}>
            {status === 'syncing' ? 'Syncing…' : linked ? 'Sync now' : shotCount > 0 ? 'Link this project & pull' : 'Pull this shoot'}
          </button>
          {linked && (
            <button
              className="btn btn-ghost"
              onClick={() => {
                if (confirm('Stop syncing this project with Elvis? Shots stay here; nothing is deleted in Elvis.')) {
                  const doc = useTrackerStore.getState().doc;
                  useTrackerStore.getState().applyMergedDoc({ ...doc, elvisLinked: false });
                }
              }}
            >
              Unlink this project
            </button>
          )}
        </div>
      </Section>

      <datalist id="elvis-fields">
        {fields.map((f) => (
          <option key={f.name} value={f.name}>
            {f.sample}
          </option>
        ))}
      </datalist>
    </Modal>
  );
}

function StatusBanner({
  status,
  lastResult,
  lastSyncAt,
  assetCount,
  error,
}: {
  status: string;
  lastResult: string;
  lastSyncAt: number | null;
  assetCount: number;
  error: { error?: string; hint?: string | null; url?: string } | null;
}) {
  if (status === 'not-configured') return null;
  const tone = status === 'error' ? 'bad' : status === 'syncing' ? 'busy' : 'ok';
  return (
    <div className={`status-banner status-${tone}`}>
      <strong>
        {status === 'syncing'
          ? 'Syncing…'
          : status === 'error'
            ? 'Last sync had a problem'
            : status === 'not-linked'
              ? 'Connected — this project isn’t linked yet'
              : `Synced ${lastSyncAt ? timeAgo(lastSyncAt) : ''}`}
      </strong>
      {lastResult && <span>{lastResult}{assetCount ? ` · ${assetCount} assets in the query` : ''}</span>}
      {error?.error && <span className="elvis-step-detail">{error.error}</span>}
      {error?.url && <code className="elvis-step-url">{error.url}</code>}
      {error?.hint && <span className="elvis-step-hint">{error.hint}</span>}
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

function Modal({ title, children, onClose, wide }: { title: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className={`modal ${wide ? 'modal-wide' : ''}`} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} title="Close">
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
