/**
 * Bridge to the desktop shell.
 *
 * When the app runs inside Electron, `window.phototrack` is injected by
 * electron/preload.cjs and there are real menus, real Save/Open dialogs, and
 * an autosave-to-disk recovery file. Opened as the standalone HTML file in a
 * browser it is undefined, and callers fall back to the browser's own
 * download and file picker (see lib/projectFiles.ts and lib/autosave.ts).
 * Keeping the check here means the rest of the app never asks which one it
 * is running in.
 *
 * Project and delta files are zip archives (binary), not JSON text, so the
 * bridge passes `Uint8Array` across the preload contextBridge rather than a
 * string — contextBridge structured-clones typed arrays without needing a
 * base64 round trip.
 */

import type { ElvisConfig, ElvisHit, ElvisRequestResult } from './elvis/types';

export interface SaveResult {
  ok: boolean;
  path?: string;
  canceled?: boolean;
}

export interface OpenResult {
  ok: boolean;
  path?: string;
  bytes?: Uint8Array;
  canceled?: boolean;
}

export interface DesktopBridge {
  platform: string;

  /** Save the open project. `forceDialog` is Save As. */
  save(bytes: Uint8Array, suggestedName: string, forceDialog?: boolean): Promise<SaveResult>;
  /** Open a project file picker; resolves with its bytes. */
  openProject(): Promise<OpenResult>;
  /** Export a delta file via Save dialog (never overwrites the open project). */
  exportDelta(bytes: Uint8Array, suggestedName: string): Promise<SaveResult>;
  /** Pick a delta file to import; resolves with its bytes. */
  importDelta(): Promise<OpenResult>;
  print(): Promise<{ ok: boolean }>;
  /** Export the current view (the sheet) straight to a PDF file. */
  exportPdf(suggestedName: string): Promise<SaveResult>;
  setDirty(dirty: boolean): void;

  writeRecovery(bytes: Uint8Array): Promise<{ ok: boolean }>;
  readRecovery(): Promise<{ ok: boolean; bytes?: Uint8Array }>;
  clearRecovery(): Promise<{ ok: boolean }>;
  promptRecovery(when: string): Promise<{ restore: boolean }>;

  onNew(fn: () => void): () => void;
  onSave(fn: () => void): () => void;
  onSaveAs(fn: () => void): () => void;
  onPrint(fn: () => void): () => void;
  onUndo(fn: () => void): () => void;
  onRedo(fn: () => void): () => void;
  onFileOpened(fn: (bytes: Uint8Array, path: string) => void): () => void;
  onPathChanged(fn: (path: string) => void): () => void;

  /**
   * WoodWing Elvis sync — desktop-only, because the request has to come from
   * the main process to get past CORS (the renderer's `file://` origin is
   * opaque to a real server). Config, including any API key or password,
   * lives in a local file the main process owns, encrypted at rest with
   * Electron's `safeStorage`. It is never written into the project file, a
   * delta, or anything that leaves this machine.
   */
  elvisGetConfig(): Promise<ElvisConfig>;
  elvisSetConfig(config: ElvisConfig): Promise<{ ok: boolean }>;
  elvisSearch(config: ElvisConfig): Promise<ElvisRequestResult & { hits?: ElvisHit[] }>;
  elvisUpdate(config: ElvisConfig, assetId: string, metadata: Record<string, unknown>): Promise<ElvisRequestResult>;
}

declare global {
  interface Window {
    phototrack?: DesktopBridge;
  }
}

export const desktop = (): DesktopBridge | undefined =>
  typeof window !== 'undefined' ? window.phototrack : undefined;

export const isDesktop = (): boolean => desktop() !== undefined;

export const isMac = (): boolean =>
  desktop()?.platform === 'darwin' ||
  (typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform));
