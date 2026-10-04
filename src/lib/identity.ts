import { getDeviceId } from './deviceId';
import type { FieldStamp, Role } from '@/state/schema';

/**
 * Who is using this copy of the app.
 *
 * Not an account or a login — PhotoTrack has no server of its own to check
 * one against. It's a name that goes on every change and every comment, so
 * that across sites and time zones "QC ✓" always comes with "by whom, when",
 * and an executive's concern shows who raised it. Stored per machine in
 * localStorage: a few bytes, outside any project file.
 */

export interface Identity {
  name: string;
  role: Role;
}

const KEY = 'phototrack.identity';

type Listener = () => void;
const listeners = new Set<Listener>();
let cached: Identity | null | undefined;

export function getIdentity(): Identity | null {
  if (cached !== undefined) return cached;
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? (JSON.parse(raw) as Partial<Identity>) : null;
    cached = parsed && parsed.name ? { name: String(parsed.name), role: parsed.role === 'executive' ? 'executive' : 'staff' } : null;
  } catch {
    cached = null;
  }
  return cached;
}

export function setIdentity(identity: Identity): void {
  cached = { name: identity.name.trim(), role: identity.role };
  try {
    localStorage.setItem(KEY, JSON.stringify(cached));
  } catch {
    // Private browsing can refuse; the name still applies for this session.
  }
  listeners.forEach((l) => l());
}

export function onIdentityChange(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The display name to stamp edits with. */
export const currentUserName = (): string => getIdentity()?.name ?? '';

/** A fresh edit stamp for "now, by me, on this machine". */
export function stampNow(at: number = Date.now()): FieldStamp {
  const u = currentUserName();
  return u ? { t: at, d: getDeviceId(), u } : { t: at, d: getDeviceId() };
}
