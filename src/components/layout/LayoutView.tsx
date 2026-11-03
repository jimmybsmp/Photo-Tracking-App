import { memo, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import { useTrackerStore } from '@/state/useTrackerStore';
import { layoutSlots, rejectLabel, rejectsOf, sideStatusLabel } from '@/state/selectors';
import { propertyStyle } from '@/state/properties';
import { MAX_CROP_ZOOM, trackOf, trackPath, type Crop, type PropertyDef } from '@/state/schema';
import { useProperties } from '@/components/ui/hooks';

/**
 * The Layout page: one property at a time, slot by slot — spread 1, spread 2,
 * … — with the select large on the left and its alts beside it on the right,
 * so the whole run of a publication can be looked at as pictures.
 *
 * Each photo sits in a fixed frame and can be framed in on its subject: press
 * Crop, drag to move, scroll (or the slider) to zoom. The framing is kept per
 * property on the shot's track (`crop`), so it reaches every site and the
 * same photo can be framed differently in the magazine and the press release.
 * It changes nothing about the photo itself.
 */

type Size = 's' | 'm' | 'l';
type Shape = 'landscape' | 'portrait' | 'square';

const SIZES: Record<Size, { label: string; main: number }> = {
  s: { label: 'S', main: 220 },
  m: { label: 'M', main: 320 },
  l: { label: 'L', main: 460 },
};
const SHAPES: Record<Shape, { label: string; ratio: number }> = {
  landscape: { label: 'Landscape', ratio: 3 / 2 },
  portrait: { label: 'Portrait', ratio: 2 / 3 },
  square: { label: 'Square', ratio: 1 },
};
/** Alts beside a select, as a share of the select's width. */
const ALT_SCALE = 0.6;

/** A viewer's own preference — remembered on this computer, never in the project. */
function usePref<T extends string>(key: string, fallback: T, allowed: readonly string[]): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const v = localStorage.getItem(`phototrack.layout.${key}`);
      return v && allowed.includes(v) ? (v as T) : fallback;
    } catch {
      return fallback;
    }
  });
  const set = (v: T) => {
    setValue(v);
    try {
      localStorage.setItem(`phototrack.layout.${key}`, v);
    } catch {
      /* private mode: just not remembered */
    }
  };
  return [value, set];
}

export function LayoutView() {
  const doc = useTrackerStore((s) => s.doc);
  const properties = useProperties();
  const [chosen, setChosen] = usePref<string>('property', properties[0]?.id ?? '', properties.map((p) => p.id));
  const [size, setSize] = usePref<Size>('size', 'm', Object.keys(SIZES));
  const [shape, setShape] = usePref<Shape>('shape', 'landscape', Object.keys(SHAPES));
  const prop = properties.find((p) => p.id === chosen) ?? properties[0];
  const slots = useMemo(() => (prop ? layoutSlots(doc, prop.id) : []), [doc, prop]);

  if (!prop) return <div className="empty-state">Add a property to lay out shots.</div>;

  const main = SIZES[size].main;
  const frame = { main, alt: Math.round(main * ALT_SCALE), ratio: SHAPES[shape].ratio };
  const placed = slots.filter((s) => s.position);
  const shots = slots.reduce((n, s) => n + s.mains.length + s.alts.length, 0);

  return (
    <div className="view-col">
      <div className="layout-bar no-print">
        <div className="layout-props">
          {properties.map((p) => (
            <button
              key={p.id}
              className={`prop-toggle ${p.id === prop.id ? 'prop-toggle-on' : ''}`}
              style={propertyStyle(p.color) as CSSProperties}
              onClick={() => setChosen(p.id)}
            >
              {p.name}
            </button>
          ))}
        </div>
        <span className="spacer" />
        <div className="segmented segmented-sm" title="Frame shape">
          {(Object.keys(SHAPES) as Shape[]).map((k) => (
            <button key={k} className={shape === k ? 'seg-active' : ''} onClick={() => setShape(k)}>
              {SHAPES[k].label}
            </button>
          ))}
        </div>
        <div className="segmented segmented-sm" title="Picture size">
          {(Object.keys(SIZES) as Size[]).map((k) => (
            <button key={k} className={size === k ? 'seg-active' : ''} onClick={() => setSize(k)}>
              {SIZES[k].label}
            </button>
          ))}
        </div>
        <span className="muted small">
          {shots} shot{shots === 1 ? '' : 's'} · {placed.length} {prop.positionLabel.replace(/\s*#$/, '').toLowerCase() || 'slot'}
          {placed.length === 1 ? '' : 's'}
        </span>
      </div>

      <div className="layout-scroll">
        <div className="layout-page" style={propertyStyle(prop.color) as CSSProperties}>
          <header className="layout-head">
            <h1>{prop.name} — layout</h1>
            <span className="layout-legend">
              <span>Selects</span>
              <span>Alts</span>
            </span>
          </header>
          {slots.length === 0 ? (
            <p className="muted center layout-empty">No shots run in {prop.name} yet — choose it under “Runs in” on a shot.</p>
          ) : (
            slots.map((slot) => (
              <section key={slot.position || '—'} className={`layout-slot ${slot.position ? '' : 'layout-slot-unplaced'}`}>
                <div className="slot-label">
                  {slot.position ? (
                    <>
                      <span className="slot-kind">{prop.positionLabel.replace(/\s*#$/, '')}</span>
                      <span className="slot-num">{slot.position}</span>
                    </>
                  ) : (
                    <span className="slot-kind">Not placed yet</span>
                  )}
                </div>
                <div className="slot-mains">
                  {slot.mains.length === 0 ? (
                    <div className="slot-missing" style={{ width: frame.main, aspectRatio: String(frame.ratio) }}>
                      No select
                    </div>
                  ) : (
                    slot.mains.map((id) => <LayoutCard key={id} rowId={id} prop={prop} width={frame.main} ratio={frame.ratio} kind="main" />)
                  )}
                </div>
                <div className="slot-alts">
                  {slot.alts.length === 0 ? (
                    <span className="muted small slot-noalts">No alts</span>
                  ) : (
                    slot.alts.map((id) => <LayoutCard key={id} rowId={id} prop={prop} width={frame.alt} ratio={frame.ratio} kind="alt" />)
                  )}
                </div>
              </section>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */

const NO_CROP: Crop = { x: 50, y: 50, zoom: 1 };

/**
 * Where the photo sits in its frame for a crop: scaled to cover the frame,
 * times the crop's zoom, with the crop's point (percent of the photo) in the
 * middle of the frame — moved only as far as keeps the frame covered.
 * Returns the framing actually shown, so a drag past an edge stops there.
 */
function placement(crop: Crop | null, frameW: number, frameH: number, natW: number, natH: number) {
  const c = crop ?? NO_CROP;
  const scale = Math.max(frameW / natW, frameH / natH) * c.zoom;
  const w = natW * scale;
  const h = natH * scale;
  // The centre point can't come closer to an edge than half the frame.
  const halfX = (frameW / 2 / w) * 100;
  const halfY = (frameH / 2 / h) * 100;
  const x = Math.min(100 - halfX, Math.max(halfX, c.x));
  const y = Math.min(100 - halfY, Math.max(halfY, c.y));
  return {
    shown: { x, y, zoom: c.zoom },
    w,
    h,
    style: { width: w, height: h, left: frameW / 2 - (x / 100) * w, top: frameH / 2 - (y / 100) * h } as CSSProperties,
  };
}

function LayoutCardImpl({ rowId, prop, width, ratio, kind }: { rowId: string; prop: PropertyDef; width: number; ratio: number; kind: 'main' | 'alt' }) {
  const row = useTrackerStore((s) => s.doc.rows[rowId]);
  const url = useTrackerStore((s) => {
    const asset = row?.imageHash ? s.doc.assets[row.imageHash] : undefined;
    return asset ? asset.reviewUrl || asset.thumbUrl : undefined;
  });
  const active = useTrackerStore((s) => s.activeRowId === rowId);
  const setField = useTrackerStore((s) => s.setField);
  const openRow = useTrackerStore((s) => s.openRow);
  const [editing, setEditing] = useState(false);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  // The framing while it's being changed — drawn straight to the image and
  // saved once when the drag ends, never a store update per mouse move.
  const live = useRef<Crop | null>(null);
  const drag = useRef<{ x: number; y: number; start: Crop } | null>(null);

  const saved = row ? trackOf(row, prop.id).crop : null;
  useEffect(() => {
    live.current = saved;
  }, [saved]);
  useEffect(() => {
    if (!editing) return undefined;
    const done = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || e.key === 'Enter') setEditing(false);
    };
    window.addEventListener('keydown', done);
    return () => window.removeEventListener('keydown', done);
  }, [editing]);

  // Scrolling zooms while framing; a non-passive listener so the page doesn't scroll too.
  useEffect(() => {
    const el = frameRef.current;
    if (!el || !editing) return undefined;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const c = live.current ?? NO_CROP;
      commit({ ...c, zoom: Math.min(MAX_CROP_ZOOM, Math.max(1, c.zoom * (1 - e.deltaY * 0.0015))) }, true);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  });

  if (!row) return null;
  const rejects = rejectsOf(row, prop.id);
  const height = Math.round(width / ratio);
  const place = (c: Crop | null) => (natural ? placement(c, width, height, natural.w, natural.h) : null);

  const paint = (c: Crop) => {
    const p = place(c);
    live.current = p ? p.shown : c;
    if (imgRef.current && p) Object.assign(imgRef.current.style, { width: `${p.w}px`, height: `${p.h}px`, left: `${p.style.left}px`, top: `${p.style.top}px` });
  };
  /** Save a framing. `typing` folds a run of wheel or slider steps into one undo. */
  const commit = (c: Crop, typing = false) => {
    paint(c);
    // Save what's shown — a crop pushed past an edge is stored where it stopped.
    setField(rowId, trackPath(prop.id, 'crop'), live.current ?? c, { typing });
  };

  const onDown = (e: ReactPointerEvent) => {
    if (!editing) return;
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, start: place(live.current)?.shown ?? live.current ?? NO_CROP };
  };
  const onMove = (e: ReactPointerEvent) => {
    const d = drag.current;
    if (!d) return;
    // The photo follows the hand: dragging right brings its left side into view.
    const p = place(d.start);
    if (!p) return;
    paint({ zoom: d.start.zoom, x: clamp(d.start.x - ((e.clientX - d.x) / p.w) * 100), y: clamp(d.start.y - ((e.clientY - d.y) / p.h) * 100) });
  };
  const onUp = () => {
    if (!drag.current) return;
    drag.current = null;
    if (live.current) commit(live.current);
  };

  const label = row.shotNum || row.elvisName || 'Untitled';
  return (
    <figure
      className={`layout-card layout-card-${kind} ${active ? 'layout-card-active' : ''} ${rejects.length ? 'layout-card-rejected' : ''}`}
      style={{ width }}
    >
      <div
        ref={frameRef}
        className={`lc-frame ${editing ? 'lc-frame-editing' : ''}`}
        style={{ height }}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onDoubleClick={() => !editing && openRow(rowId)}
        title={editing ? 'Drag to move · scroll to zoom' : 'Double-click to open the shot'}
      >
        {url ? (
          <img
            ref={imgRef}
            src={url}
            alt=""
            draggable={false}
            className={natural ? 'lc-placed' : ''}
            style={place(saved)?.style}
            onLoad={(e) => setNatural({ w: e.currentTarget.naturalWidth || 1, h: e.currentTarget.naturalHeight || 1 })}
          />
        ) : (
          <span className="lc-empty">No photo</span>
        )}
        {rejects.length > 0 && <span className="tile-reject">{rejectLabel(rejects)}</span>}
        {url && !editing && (
          <button className="lc-crop-btn no-print" onClick={() => setEditing(true)} title="Frame this photo on its subject">
            Crop
          </button>
        )}
      </div>
      {editing && (
        <div className="lc-crop-tools no-print">
          <input
            type="range"
            min={1}
            max={MAX_CROP_ZOOM}
            step={0.05}
            value={(live.current ?? saved)?.zoom ?? 1}
            onChange={(e) => commit({ ...(live.current ?? NO_CROP), zoom: Number(e.target.value) }, true)}
            aria-label="Zoom"
          />
          <button className="btn btn-sm btn-ghost" onClick={() => commit(NO_CROP)}>
            Reset
          </button>
          <button className="btn btn-sm btn-primary" onClick={() => setEditing(false)}>
            Done
          </button>
        </div>
      )}
      <figcaption>
        <span className="lc-name">{label}</span>
        <span className={`lc-status ${rejects.length ? 'reject-text' : ''}`}>{sideStatusLabel(row, prop.id)}</span>
      </figcaption>
    </figure>
  );
}

const clamp = (n: number) => Math.min(100, Math.max(0, n));

const LayoutCard = memo(LayoutCardImpl);
