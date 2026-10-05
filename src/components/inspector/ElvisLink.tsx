import { useEffect, useRef, useState } from 'react';
import { isDesktop } from '@/lib/desktop';
import { assetThumbUrl, linkShot, lookupAsset, unlinkShot, useSyncStore } from '@/lib/elvis/autoSync';
import { alreadyLinked, assetModifiedAt, factsOf } from '@/lib/elvis/link';
import { isConfigured, type ElvisHit } from '@/lib/elvis/types';
import { stampTime } from '@/lib/format';
import { toast } from '@/lib/toast';
import { useTrackerStore } from '@/state/useTrackerStore';
import type { ShotRow } from '@/state/schema';

/**
 * A shot's link to its Elvis asset — the retoucher's step once their first
 * pass is in Elvis. Paste the asset's id or a link to it, or search by name
 * (the box starts with the shot number, so usually it's one click), check
 * the picture, link. From then on the shot shows that asset's latest preview.
 */
export function ElvisLink({ row }: { row: ShotRow }) {
  const connected = useSyncStore((s) => isConfigured(s.config));
  const missing = useSyncStore((s) => Boolean(row.elvisAssetId) && s.missing.includes(row.elvisAssetId));

  if (!isDesktop()) return null;
  return (
    <section className="inspector-section elvis-link">
      <h3>Elvis</h3>
      {row.elvisAssetId ? (
        <Linked row={row} missing={missing} />
      ) : connected ? (
        <Finder key={row.id} row={row} />
      ) : (
        <p className="muted small">Connect to Elvis (top right) to link this shot to its retouched file.</p>
      )}
    </section>
  );
}

function Linked({ row, missing }: { row: ShotRow; missing: boolean }) {
  const stamp = row.fieldTimes.elvisAssetId;
  return (
    <div className="linked">
      <div className="linked-name">
        <span className="pill pill-elvis">Linked</span>
        <span title={row.elvisAssetId}>{row.elvisName || row.elvisAssetId}</span>
      </div>
      {row.elvisPath && <div className="muted small">{row.elvisPath}</div>}
      {stamp?.u && (
        <div className="muted small">
          Linked by {stamp.u} · {stampTime(stamp.t)}
        </div>
      )}
      {missing && (
        <p className="notice small">Elvis no longer has this asset, or this account can't see it. The last picture stays.</p>
      )}
      <p className="muted small">The picture updates whenever a new version is checked in to Elvis.</p>
      <button
        type="button"
        className="btn btn-sm btn-ghost"
        onClick={() => {
          if (confirm('Unlink this shot from Elvis? Its current picture stays.')) unlinkShot(row.id);
        }}
      >
        Unlink
      </button>
    </div>
  );
}

function Finder({ row }: { row: ShotRow }) {
  const [text, setText] = useState(row.shotNum);
  const [hits, setHits] = useState<ElvisHit[] | null>(null);
  const [more, setMore] = useState(false);
  const [error, setError] = useState('');
  const [searching, setSearching] = useState(false);
  const [linking, setLinking] = useState<string | null>(null);
  const search = useRef(0);

  const find = async () => {
    const ticket = ++search.current;
    setSearching(true);
    setError('');
    try {
      const result = await lookupAsset(text);
      if (ticket !== search.current) return;
      if (result.ok) {
        setHits(result.hits ?? []);
        setMore(Boolean(result.more));
      } else {
        setHits(null);
        setError(result.error ?? 'Elvis could not be searched.');
      }
    } finally {
      if (ticket === search.current) setSearching(false);
    }
  };

  const link = async (hit: ElvisHit) => {
    const other = alreadyLinked(useTrackerStore.getState().doc, hit.id, row.id);
    if (other && !confirm(`${factsOf(hit).name} is already linked to shot ${other.shotNum || 'without a number'}. Link it here too?`)) return;
    setLinking(hit.id);
    try {
      const result = await linkShot(row.id, hit);
      if (!result.ok) setError(result.warning ?? 'Could not link.');
      else toast(result.warning ?? `Linked to ${factsOf(hit).name}`, result.warning ? 'bad' : 'good', result.warning ? 6000 : undefined);
    } finally {
      setLinking(null);
    }
  };

  return (
    <div className="finder">
      <p className="muted small">Once the retouched file is in Elvis: paste its id or link, or find it by name.</p>
      <div className="row-gap">
        <input
          className="field"
          value={text}
          placeholder="Elvis id, link, or file name"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void find();
            }
          }}
        />
        <button type="button" className="btn" onClick={() => void find()} disabled={searching || !text.trim()}>
          {searching ? 'Finding…' : 'Find'}
        </button>
      </div>
      {error && <p className="field-error small">{error}</p>}
      {hits && hits.length === 0 && <p className="muted small">Nothing in Elvis matches “{text.trim()}”.</p>}
      {hits && hits.length > 0 && (
        <ul className="candidates">
          {hits.map((hit) => (
            <Candidate key={hit.id} hit={hit} busy={linking !== null} linking={linking === hit.id} onLink={() => void link(hit)} />
          ))}
        </ul>
      )}
      {more && <p className="muted small">More matched than are shown — type more of the name.</p>}
    </div>
  );
}

function Candidate({ hit, busy, linking, onLink }: { hit: ElvisHit; busy: boolean; linking: boolean; onLink: () => void }) {
  const [thumb, setThumb] = useState<string | null>(null);
  useEffect(() => {
    let url: string | null = null;
    let alive = true;
    void assetThumbUrl(hit).then((u) => {
      if (alive) setThumb((url = u));
      else if (u) URL.revokeObjectURL(u);
    });
    return () => {
      alive = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [hit]);
  const facts = factsOf(hit);
  const modified = assetModifiedAt(hit);
  return (
    <li className="candidate">
      <div className="candidate-thumb">{thumb ? <img src={thumb} alt="" /> : null}</div>
      <div className="candidate-meta">
        <strong>{facts.name}</strong>
        <span className="muted small">{facts.folder}</span>
        {modified > 1 && <span className="muted small">Changed {stampTime(modified)}</span>}
      </div>
      <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={onLink}>
        {linking ? 'Linking…' : 'Link'}
      </button>
    </li>
  );
}
