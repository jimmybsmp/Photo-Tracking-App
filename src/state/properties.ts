import { newId } from '@/lib/compat';
import { PROPERTY_COLORS, isNewerStamp, type FieldStamp, type PropertyDef, type Side } from './schema';

/**
 * The project's properties — where shots run. Each one is a whole definition
 * (name, tag, colour, what its position is called, its place in the list)
 * with one stamp, merged between sites by newest stamp like a row field. A
 * property is never deleted, only hidden (`archived`), so a shot's track in
 * it is never lost and other sites can't resurrect a half-deleted one.
 */

const byOrder = (a: PropertyDef, b: PropertyDef) => a.order - b.order || a.name.localeCompare(b.name);

/** The properties in use, in order — what every view lists. */
export function propertyList(properties: Record<Side, PropertyDef>): PropertyDef[] {
  return Object.values(properties).filter((p) => !p.archived).sort(byOrder);
}

/** Every property, hidden ones included, in order — for the property manager. */
export function allProperties(properties: Record<Side, PropertyDef>): PropertyDef[] {
  return Object.values(properties).sort(byOrder);
}

/** A new property, placed last and given the next unused colour. */
export function newProperty(properties: Record<Side, PropertyDef>, name: string, stamp: FieldStamp): PropertyDef {
  const all = Object.values(properties);
  const used = new Set(all.map((p) => p.color.toLowerCase()));
  const color = PROPERTY_COLORS.find((c) => !used.has(c.toLowerCase())) ?? PROPERTY_COLORS[all.length % PROPERTY_COLORS.length];
  const clean = name.trim() || 'New property';
  return {
    id: `p${newId().replace(/[^A-Za-z0-9]/g, '').slice(0, 10)}`,
    name: clean,
    short: shortFor(clean),
    color,
    positionLabel: 'Position',
    order: all.reduce((max, p) => Math.max(max, p.order), -1) + 1,
    archived: false,
    t: stamp,
  };
}

/** A tag from a name: initials for several words (Social Media → SM), else the first letters. */
export function shortFor(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const tag = words.length > 1 ? words.map((w) => w[0]).join('') : (words[0] ?? '').slice(0, 3);
  return tag.toUpperCase().slice(0, 4) || 'NEW';
}

/** Merge another site's property list: per property, the newer definition wins. */
export function mergeProperties(
  local: Record<Side, PropertyDef>,
  incoming: Record<Side, PropertyDef> | undefined,
): { properties: Record<Side, PropertyDef>; changed: number } {
  if (!incoming) return { properties: local, changed: 0 };
  let out = local;
  let changed = 0;
  for (const [id, theirs] of Object.entries(incoming)) {
    const ours = local[id];
    const wins = !ours || (theirs.t !== null && isNewerStamp(theirs.t, ours.t));
    if (!wins) continue;
    out = out === local ? { ...local } : out;
    out[id] = theirs;
    changed++;
  }
  return { properties: out, changed };
}

/* ------------------------------------------------------------------ *
 * Colour — one colour per property, everywhere
 * ------------------------------------------------------------------ */

function mix(hex: string, toward: [number, number, number], amount: number): string {
  const n = parseInt(hex.slice(1), 16);
  const rgb = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c, i) => Math.round(c + (toward[i] - c) * amount));
  return `#${rgb.map((c) => c.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * CSS variables for a property's colour: `--prop` (as chosen, for the dark
 * chrome), `--prop-ink` (dark, for text and ticks on white) and `--prop-wash`
 * (pale, behind a tag). Worked out here rather than with `color-mix()`, which
 * the 10.13 app's Chromium predates.
 */
export function propertyStyle(color: string): Record<string, string> {
  return { '--prop': color, '--prop-ink': mix(color, [0, 0, 0], 0.55), '--prop-wash': mix(color, [255, 255, 255], 0.8) };
}
