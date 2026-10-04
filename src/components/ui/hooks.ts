import { useEffect, useState } from 'react';
import { getIdentity, onIdentityChange, type Identity } from '@/lib/identity';

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
