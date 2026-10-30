import { useEffect, useMemo, useState } from 'react';
import { getIdentity, onIdentityChange, type Identity } from '@/lib/identity';
import { propertyList } from '@/state/properties';
import { useTrackerStore } from '@/state/useTrackerStore';
import type { PropertyDef } from '@/state/schema';

/** The project's properties in use, in order. Changes only when a property does. */
export function useProperties(): PropertyDef[] {
  const properties = useTrackerStore((s) => s.doc.properties);
  return useMemo(() => propertyList(properties), [properties]);
}

/** The current user, re-rendering when they change their name or role. */
export function useIdentity(): Identity | null {
  const [identity, setIdentityState] = useState(getIdentity);
  useEffect(() => onIdentityChange(() => setIdentityState(getIdentity())), []);
  return identity;
}

/** Re-render on an interval — for "3 min ago" labels that should stay true. */
export function useNow(ms = 30_000): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}
