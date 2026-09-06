import { useEffect, useState } from 'react';
import { canRedo, canUndo, onHistoryChange } from './history';

/** Reactive undo/redo availability, for enabling the toolbar's buttons. */
export function useHistoryFlags() {
  const [flags, setFlags] = useState(() => ({ undo: canUndo(), redo: canRedo() }));
  useEffect(() => onHistoryChange(() => setFlags({ undo: canUndo(), redo: canRedo() })), []);
  return flags;
}
