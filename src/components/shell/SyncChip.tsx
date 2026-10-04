import { useSyncStore } from '@/lib/elvis/autoSync';
import { timeAgo } from '@/lib/format';
import { useNow } from '@/components/ui/hooks';

/**
 * Where Elvis sync stands, always visible — so nobody has to wonder whether
 * what they see is current, or whether their changes have gone out.
 */
export function SyncChip({ onClick }: { onClick: () => void }) {
  const status = useSyncStore((s) => s.status);
  const lastSyncAt = useSyncStore((s) => s.lastSyncAt);
  const error = useSyncStore((s) => s.lastError?.error);
  useNow(20_000);

  let label: string;
  let tone: 'off' | 'ok' | 'busy' | 'bad';
  switch (status) {
    case 'unavailable':
      return null;
    case 'not-configured':
      label = 'Connect Elvis';
      tone = 'off';
      break;
    case 'not-linked':
      label = 'Elvis: not linked';
      tone = 'off';
      break;
    case 'syncing':
      label = 'Syncing…';
      tone = 'busy';
      break;
    case 'error':
      label = 'Elvis: not synced';
      tone = 'bad';
      break;
    default:
      label = lastSyncAt ? `Synced ${timeAgo(lastSyncAt)}` : 'Elvis connected';
      tone = 'ok';
  }

  return (
    <button className={`sync-chip sync-${tone}`} onClick={onClick} title={error || 'WoodWing Elvis sync'}>
      <span className="sync-dot" />
      {label}
    </button>
  );
}
