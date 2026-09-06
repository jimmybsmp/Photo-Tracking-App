import { useEffect, useState } from 'react';
import { desktop, isDesktop } from '@/lib/desktop';
import { defaultElvisConfig, type ElvisConfig } from '@/lib/elvis/types';
import { mergeElvisHits, metadataPatchForRow } from '@/lib/elvis/sync';
import { useTrackerStore } from '@/state/useTrackerStore';
import { Button, TextInput } from '@/components/ui/controls';

/**
 * WoodWing Elvis sync settings and manual controls.
 *
 * This only works in the desktop app — see desktop.ts for why the request
 * has to originate in the main process. The field names below are
 * placeholders (the same ones the original tool guessed at) until whoever
 * administers the DAM confirms the real custom-field names and how the
 * service account authenticates; nothing here assumes they're right, and
 * "Test connection" exists specifically so you don't have to guess.
 */
export function ElvisPanel({ onClose }: { onClose: () => void }) {
  const [config, setConfig] = useState<ElvisConfig>(defaultElvisConfig);
  const [status, setStatus] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const doc = useTrackerStore((s) => s.doc);
  const applyMergedDoc = useTrackerStore((s) => s.applyMergedDoc);

  useEffect(() => {
    const bridge = desktop();
    if (!bridge) return;
    void bridge.elvisGetConfig().then(setConfig);
  }, []);

  async function save(next: ElvisConfig) {
    setConfig(next);
    await desktop()?.elvisSetConfig(next);
  }

  async function handleTest() {
    const bridge = desktop();
    if (!bridge) return;
    setBusy(true);
    setStatus('Testing…');
    try {
      const result = await bridge.elvisSearch({ ...config, query: config.query || '*' });
      if (result.ok) setStatus(`Connected — ${result.hits?.length ?? 0} asset(s) matched the query.`);
      else setStatus(`Failed: HTTP ${result.status ?? '—'} ${result.error ?? ''}`.trim());
    } catch (err) {
      setStatus(`Failed: ${String(err)}`);
    } finally {
      setBusy(false);
    }
  }

  async function handlePullNow() {
    const bridge = desktop();
    if (!bridge) return;
    setBusy(true);
    setStatus('Pulling…');
    try {
      const result = await bridge.elvisSearch(config);
      if (!result.ok || !result.hits) {
        setStatus(`Pull failed: HTTP ${result.status ?? '—'} ${result.error ?? ''}`.trim());
        return;
      }
      const { doc: merged, summary } = mergeElvisHits(doc, result.hits, config.fieldMap);
      applyMergedDoc(merged);
      setStatus(
        `Pulled ${result.hits.length} asset(s): ${summary.rowsAdded} new, ${summary.rowsUpdated} updated ` +
          `(${summary.fieldsChanged} fields).`,
      );
    } catch (err) {
      setStatus(`Pull failed: ${String(err)}`);
    } finally {
      setBusy(false);
    }
  }

  async function handlePushChanged() {
    const bridge = desktop();
    if (!bridge) return;
    const rows = Object.values(doc.rows).filter((r) => r.elvisAssetId);
    if (rows.length === 0) {
      setStatus('No rows are linked to an Elvis asset yet — pull first.');
      return;
    }
    setBusy(true);
    setStatus(`Pushing ${rows.length} row(s)…`);
    let ok = 0;
    let failed = 0;
    for (const row of rows) {
      const result = await bridge.elvisUpdate(config, row.elvisAssetId, metadataPatchForRow(row, config.fieldMap));
      if (result.ok) ok++;
      else failed++;
    }
    setStatus(`Pushed: ${ok} succeeded, ${failed} failed.`);
    setBusy(false);
  }

  if (!isDesktop()) {
    return (
      <div className="modal-backdrop" onClick={onClose}>
        <div className="modal" onClick={(e) => e.stopPropagation()}>
          <div className="modal-header">
            <h2>WoodWing Elvis Sync</h2>
            <button className="btn-icon" onClick={onClose}>✕</button>
          </div>
          <p>
            Elvis sync needs the desktop app — a browser page can't authenticate to your DAM or get past its CORS
            policy. Everything else in PhotoTrack (saving, the grid, delta files between units) works the same
            either way.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>WoodWing Elvis Sync</h2>
          <button className="btn-icon" onClick={onClose}>✕</button>
        </div>

        <label className="inspector-field">
          <span>Enabled</span>
          <input type="checkbox" checked={config.enabled} onChange={(e) => void save({ ...config, enabled: e.target.checked })} />
        </label>

        <label className="inspector-field">
          <span>Server endpoint</span>
          <TextInput
            value={config.endpoint}
            placeholder="https://dam.yourcompany.com/services"
            onChange={(e) => void save({ ...config, endpoint: e.target.value })}
          />
        </label>

        <div className="modal-row">
          <label className="inspector-field">
            <span>Search path</span>
            <TextInput value={config.searchPath} onChange={(e) => void save({ ...config, searchPath: e.target.value })} />
          </label>
          <label className="inspector-field">
            <span>Update path</span>
            <TextInput value={config.updatePath} onChange={(e) => void save({ ...config, updatePath: e.target.value })} />
          </label>
          <label className="inspector-field">
            <span>Search method</span>
            <select
              className="field"
              value={config.searchMethod}
              onChange={(e) => void save({ ...config, searchMethod: e.target.value as ElvisConfig['searchMethod'] })}
            >
              <option value="POST">POST</option>
              <option value="GET">GET</option>
            </select>
          </label>
        </div>

        <label className="inspector-field">
          <span>Query</span>
          <TextInput
            value={config.query}
            placeholder="assetPath:/Projects/2026/*"
            onChange={(e) => void save({ ...config, query: e.target.value })}
          />
        </label>

        <div className="modal-row">
          <label className="inspector-field">
            <span>Auth</span>
            <select className="field" value={config.authMode} onChange={(e) => void save({ ...config, authMode: e.target.value as ElvisConfig['authMode'] })}>
              <option value="none">None</option>
              <option value="apikey">API key (header)</option>
              <option value="basic">Basic auth</option>
            </select>
          </label>
          {config.authMode === 'apikey' && (
            <label className="inspector-field">
              <span>API key</span>
              <TextInput type="password" value={config.apiKey} onChange={(e) => void save({ ...config, apiKey: e.target.value })} />
            </label>
          )}
          {config.authMode === 'basic' && (
            <>
              <label className="inspector-field">
                <span>Username</span>
                <TextInput value={config.username} onChange={(e) => void save({ ...config, username: e.target.value })} />
              </label>
              <label className="inspector-field">
                <span>Password</span>
                <TextInput type="password" value={config.password} onChange={(e) => void save({ ...config, password: e.target.value })} />
              </label>
            </>
          )}
        </div>

        <details>
          <summary className="inspector-field-summary">Custom field names (confirm these with your DAM admin)</summary>
          <div className="modal-grid">
            {(Object.keys(config.fieldMap) as Array<keyof ElvisConfig['fieldMap']>).map((key) => (
              <label className="inspector-field" key={key}>
                <span>{key}</span>
                <TextInput
                  value={config.fieldMap[key]}
                  onChange={(e) => void save({ ...config, fieldMap: { ...config.fieldMap, [key]: e.target.value } })}
                />
              </label>
            ))}
          </div>
        </details>

        <div className="modal-actions">
          <Button onClick={() => void handleTest()} disabled={busy || !config.endpoint}>
            Test connection
          </Button>
          <Button onClick={() => void handlePullNow()} disabled={busy || !config.endpoint}>
            Pull now
          </Button>
          <Button onClick={() => void handlePushChanged()} disabled={busy || !config.endpoint}>
            Push changed rows
          </Button>
        </div>
        {status && <p className="inspector-hint">{status}</p>}
      </div>
    </div>
  );
}
