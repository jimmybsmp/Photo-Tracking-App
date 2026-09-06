/**
 * Small shims so the app runs on older browsers.
 *
 * This matters because the offline build is a single HTML file opened by
 * double-clicking, on whatever browser the machine already has — which on an
 * air-gapped Mac running 10.13 means Safari 13.1. These are 2021-era APIs
 * that browser does not have, and without a fallback the app would not start.
 */

/** A unique id. `crypto.randomUUID` needs Safari 15.4+ / Chrome 92+. */
export function newId(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();

  // RFC 4122 v4 from getRandomValues, then from Math.random as a last resort.
  const bytes = new Uint8Array(16);
  if (c && typeof c.getRandomValues === 'function') {
    c.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex: string[] = [];
  for (let i = 0; i < 16; i++) hex.push(bytes[i].toString(16).padStart(2, '0'));
  return (
    hex.slice(0, 4).join('') +
    '-' +
    hex.slice(4, 6).join('') +
    '-' +
    hex.slice(6, 8).join('') +
    '-' +
    hex.slice(8, 10).join('') +
    '-' +
    hex.slice(10, 16).join('')
  );
}

/** Deep copy. `structuredClone` needs Safari 15.4+ / Chrome 98+. */
export function deepClone<T>(value: T): T {
  const g = globalThis as { structuredClone?: <V>(v: V) => V };
  if (typeof g.structuredClone === 'function') return g.structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * Content hash for an image's bytes, used to key the asset store so the same
 * frame imported twice (or synced back from a peer) dedupes to one copy.
 *
 * `crypto.subtle` needs a secure context — https, localhost, or an app
 * origin — and Safari treats a bare `file://` page as one only from 13.1 on,
 * later than this app otherwise supports. When it is unavailable this falls
 * back to a pair of 32-bit rolling hashes (FNV-1a with two different primes)
 * combined into a 64-bit digest. That is not cryptographic, but content
 * addressing here only needs to avoid *accidental* collisions among the
 * images in one production's shoot — a few thousand frames at most — and a
 * 64-bit space puts that risk far below any threshold worth worrying about.
 */
export async function hashBytes(bytes: ArrayBuffer): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle && typeof subtle.digest === 'function') {
    try {
      const digest = await subtle.digest('SHA-256', bytes);
      return toHex(new Uint8Array(digest));
    } catch {
      // Fall through to the JS fallback — some browsers expose `subtle` but
      // refuse to use it outside a secure context.
    }
  }
  return fnv64(new Uint8Array(bytes));
}

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, '0');
  return out;
}

function fnv64(bytes: Uint8Array): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x1000193 ^ bytes.length;
  for (let i = 0; i < bytes.length; i++) {
    h1 ^= bytes[i];
    h1 = Math.imul(h1, 0x01000193);
    h2 ^= bytes[i] + i;
    h2 = Math.imul(h2, 0x85ebca6b);
  }
  return (
    'js' +
    (h1 >>> 0).toString(16).padStart(8, '0') +
    (h2 >>> 0).toString(16).padStart(8, '0')
  );
}
