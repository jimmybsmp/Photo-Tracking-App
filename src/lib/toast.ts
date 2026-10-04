import { create } from 'zustand';

/**
 * Brief, non-blocking notices ("Saved", "Merged 3 shots") — instead of
 * `alert()`, which stops everything until someone clicks OK.
 */

export interface Toast {
  id: number;
  text: string;
  tone: 'info' | 'good' | 'bad';
}

interface ToastState {
  toasts: Toast[];
}

export const useToastStore = create<ToastState>(() => ({ toasts: [] }));

let nextId = 1;

export function toast(text: string, tone: Toast['tone'] = 'info', ms = 4000) {
  const id = nextId++;
  useToastStore.setState((s) => ({ toasts: [...s.toasts, { id, text, tone }] }));
  setTimeout(() => useToastStore.setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), ms);
}
