/**
 * WoodWing Elvis — configuration and wire types.
 *
 * What PhotoTrack does in Elvis, and nothing else:
 *
 *   - Each shot can be linked to one Elvis asset, by hand, by the retoucher
 *     once their first pass is in Elvis (paste its id or link, or find it by
 *     name). From then on the shot's picture follows that asset's preview:
 *     a new version in Elvis shows up in PhotoTrack on the next sync. Every
 *     other asset — the test frames, the rejects — is ignored.
 *
 *   - A project is shared through one tracking file per shoot, e.g.
 *     /PhotoTrack/Gala 2026.ptdelta, holding every shot's status, who did
 *     what and when, and every comment (see sharedFile.ts). Photos dropped in
 *     before they're in Elvis travel as thumbnails in a companion file beside
 *     it, so the other sites see them too.
 *
 * PhotoTrack never writes to a photo.
 *
 * The connection (server, login) belongs to this computer and lives in the
 * desktop app's own encrypted config. Which shared file a project uses
 * belongs to the project (`doc.elvisFile`).
 */

export type ElvisAuthMode = 'login' | 'apikey' | 'basic' | 'none';
export type ElvisSearchMethod = 'GET' | 'POST';

export interface ElvisConfig {
  /** Keep shared projects in sync automatically. */
  enabled: boolean;
  /** Seconds between automatic syncs. Edits also trigger one shortly after. */
  intervalSec: number;
  /** Base URL — the browser address works; `/services` is added. */
  endpoint: string;
  searchPath: string;
  searchMethod: ElvisSearchMethod;
  authMode: ElvisAuthMode;
  /** Kept only in the desktop app's own encrypted config — never in a project or delta file. */
  apiKey: string;
  username: string;
  password: string;
}

export const defaultElvisConfig: ElvisConfig = {
  enabled: true,
  intervalSec: 60,
  endpoint: '',
  searchPath: '/search',
  searchMethod: 'POST',
  authMode: 'login',
  apiKey: '',
  username: '',
  password: '',
};

/**
 * Accept a stored config from any version and keep only what still means
 * something — the folder query, record field and plain-field mapping of
 * earlier versions are dropped.
 */
export function normalizeElvisConfig(raw: unknown): ElvisConfig {
  const r = (raw ?? {}) as Partial<ElvisConfig>;
  const str = (v: unknown, fallback: string) => (typeof v === 'string' ? v : fallback);
  return {
    enabled: typeof r.enabled === 'boolean' ? r.enabled : defaultElvisConfig.enabled,
    intervalSec: Math.max(15, Number(r.intervalSec) || defaultElvisConfig.intervalSec),
    endpoint: str(r.endpoint, ''),
    searchPath: str(r.searchPath, '') || defaultElvisConfig.searchPath,
    searchMethod: r.searchMethod === 'GET' ? 'GET' : 'POST',
    authMode: r.authMode === 'apikey' || r.authMode === 'basic' || r.authMode === 'none' ? r.authMode : 'login',
    apiKey: str(r.apiKey, ''),
    username: str(r.username, ''),
    password: str(r.password, ''),
  };
}

/** Enough filled in to try connecting. */
export const isConfigured = (c: ElvisConfig) => Boolean(c.endpoint.trim()) && (c.authMode !== 'login' || Boolean(c.username.trim()));

export interface ElvisHit {
  id: string;
  name?: string;
  thumbnailUrl?: string;
  previewUrl?: string;
  /** The file itself — present when the account may download it. */
  originalUrl?: string;
  metadata: Record<string, unknown>;
}

export interface ElvisRequestResult {
  ok: boolean;
  status?: number;
  /** Which step failed: address, login, search, lookup, file, upload. */
  stage?: string;
  /** The exact URL that was tried, for checking against what the admin expects. */
  url?: string;
  error?: string;
  /** A plain-language explanation of what usually causes this error. */
  hint?: string | null;
}

export interface ElvisTestStep {
  ok: boolean;
  label: string;
  detail?: string;
  hint?: string | null;
  url?: string;
}

export interface ElvisTestResult {
  ok: boolean;
  steps: ElvisTestStep[];
}

export interface ElvisLookupResult extends ElvisRequestResult {
  hits?: ElvisHit[];
  /** Found by its id (one asset), or by name (candidates to choose from). */
  by?: 'id' | 'name';
  /** More matched than are listed — type more of the name. */
  more?: boolean;
}

export interface ElvisIdsResult extends ElvisRequestResult {
  hits?: ElvisHit[];
  /** Linked ids Elvis no longer returns. */
  missing?: string[];
}

export interface ElvisFileResult extends ElvisRequestResult {
  bytes?: Uint8Array;
  mime?: string;
}

export type ElvisImageResult = ElvisFileResult;

export interface ElvisFindResult extends ElvisRequestResult {
  hits?: ElvisHit[];
}

export interface ElvisUpload {
  /** Check in a new version of this asset; omitted, a new asset is created at `assetPath`. */
  id?: string;
  assetPath: string;
  fileName?: string;
  bytes: Uint8Array;
  contentType?: string;
}

export interface ElvisUploadResult extends ElvisRequestResult {
  id?: string;
}
