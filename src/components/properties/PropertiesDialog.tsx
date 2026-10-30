import { useMemo, useState, type CSSProperties } from 'react';
import { useTrackerStore } from '@/state/useTrackerStore';
import { allProperties, propertyStyle } from '@/state/properties';
import { PROPERTY_COLORS, type PropertyDef } from '@/state/schema';
import { Modal } from '@/components/ui/Modal';

/**
 * The project's properties — where shots can run. Every property works the
 * same way: its own five stages, retoucher, position and select, and a shot
 * can run in any number of them. Changes here reach every site through the
 * shared file like any other edit.
 *
 * Hiding a property takes it out of every view and count; nothing in it is
 * deleted, and showing it again brings every shot's track back as it was.
 */
export function PropertiesDialog({ onClose }: { onClose: () => void }) {
  const properties = useTrackerStore((s) => s.doc.properties);
  const rows = useTrackerStore((s) => s.doc.rows);
  const addProperty = useTrackerStore((s) => s.addProperty);
  const [name, setName] = useState('');

  const list = useMemo(() => allProperties(properties), [properties]);
  const visible = list.filter((p) => !p.archived);
  const hidden = list.filter((p) => p.archived);
  const counts = useMemo(() => {
    const out: Record<string, number> = {};
    for (const row of Object.values(rows)) for (const [id, t] of Object.entries(row.tracks)) if (t.on) out[id] = (out[id] ?? 0) + 1;
    return out;
  }, [rows]);

  const add = () => {
    if (!name.trim()) return;
    addProperty(name);
    setName('');
  };

  return (
    <Modal title="Properties" onClose={onClose} wide>
      <p className="muted small">
        Where shots run. Each property has its own stages, retoucher, position and select, and a shot can run in any
        combination of them — choose under <strong>Runs in</strong> on the shot.
      </p>

      <ul className="prop-list">
        {visible.map((p, i) => (
          <PropertyEditor key={p.id} prop={p} count={counts[p.id] ?? 0} first={i === 0} last={i === visible.length - 1} />
        ))}
      </ul>

      <div className="row-gap prop-add">
        <input
          className="field"
          value={name}
          placeholder="New property, e.g. Website, Social, Annual report"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && add()}
        />
        <button type="button" className="btn btn-primary" disabled={!name.trim()} onClick={add}>
          Add property
        </button>
      </div>

      {hidden.length > 0 && (
        <section className="prop-hidden">
          <h4>Hidden</h4>
          <ul className="prop-list">
            {hidden.map((p) => (
              <PropertyEditor key={p.id} prop={p} count={counts[p.id] ?? 0} first last />
            ))}
          </ul>
        </section>
      )}
    </Modal>
  );
}

function PropertyEditor({ prop, count, first, last }: { prop: PropertyDef; count: number; first: boolean; last: boolean }) {
  const update = useTrackerStore((s) => s.updateProperty);
  const move = useTrackerStore((s) => s.moveProperty);
  const setArchived = useTrackerStore((s) => s.setPropertyArchived);
  const [picking, setPicking] = useState(false);

  return (
    <li className={`prop-item ${prop.archived ? 'prop-item-hidden' : ''}`} style={propertyStyle(prop.color) as CSSProperties}>
      <div className="prop-swatch-wrap">
        <button type="button" className="prop-swatch" title="Colour" onClick={() => setPicking((v) => !v)} />
        {picking && (
          <div className="prop-palette">
            {PROPERTY_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                className={`prop-swatch ${c.toLowerCase() === prop.color.toLowerCase() ? 'prop-swatch-on' : ''}`}
                style={{ background: c }}
                onClick={() => {
                  update(prop.id, { color: c });
                  setPicking(false);
                }}
              />
            ))}
          </div>
        )}
      </div>
      <label className="field-label prop-name">
        <span>Name</span>
        <input className="field" value={prop.name} onChange={(e) => update(prop.id, { name: e.target.value })} />
      </label>
      <label className="field-label prop-short">
        <span>Tag</span>
        <input className="field" value={prop.short} maxLength={6} onChange={(e) => update(prop.id, { short: e.target.value })} />
      </label>
      <label className="field-label prop-pos">
        <span>Position is called</span>
        <input className="field" value={prop.positionLabel} placeholder="Page #" onChange={(e) => update(prop.id, { positionLabel: e.target.value })} />
      </label>
      <span className="muted small prop-count">
        {count} shot{count === 1 ? '' : 's'}
      </span>
      <div className="prop-actions">
        {!prop.archived && (
          <>
            <button type="button" className="icon-btn" disabled={first} title="Move up" onClick={() => move(prop.id, -1)}>
              ↑
            </button>
            <button type="button" className="icon-btn" disabled={last} title="Move down" onClick={() => move(prop.id, 1)}>
              ↓
            </button>
          </>
        )}
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          onClick={() => {
            if (prop.archived || confirm(`Hide ${prop.name}? It leaves every view and count. Nothing is deleted — show it again any time.`)) {
              setArchived(prop.id, !prop.archived);
            }
          }}
        >
          {prop.archived ? 'Show' : 'Hide'}
        </button>
      </div>
    </li>
  );
}
