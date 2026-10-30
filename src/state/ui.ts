import { create } from 'zustand';

/**
 * App-wide dialogs that more than one place opens — the property manager is
 * reached from the shot panel, the overview and the File menu.
 */
interface UiStore {
  propertiesOpen: boolean;
  openProperties: () => void;
  closeProperties: () => void;
}

export const useUiStore = create<UiStore>((set) => ({
  propertiesOpen: false,
  openProperties: () => set({ propertiesOpen: true }),
  closeProperties: () => set({ propertiesOpen: false }),
}));
