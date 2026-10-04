/** Small display formatters shared by every view. */

/** "just now", "4 min ago", "3 h ago", or a date for anything older than a day. */
export function timeAgo(at: number, now: number = Date.now()): string {
  if (!at || at < 10) return '';
  const s = Math.round((now - at) / 1000);
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return shortDate(at);
}

export function shortDate(at: number): string {
  return new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** "Oct 4, 14:02" */
export function stampTime(at: number): string {
  const d = new Date(at);
  return `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}, ${d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export const pct = (done: number, total: number) => (total ? Math.round((done / total) * 100) : 0);
