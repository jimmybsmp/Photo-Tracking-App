/**
 * WoodWing Elvis sync — configuration and wire types.
 *
 * Two ways PhotoTrack stores tracking data on an Elvis asset:
 *
 *   recordField — ONE custom text field holding the shot's complete state as
 *     JSON: both properties, every stage with who marked it and when, and the
 *     comment thread. This is what lets sites in different places work on the
 *     same shoot: each one merges the record field by field, the same way
 *     delta files merge, so nobody's work overwrites anyone else's. It needs
 *     an Elvis administrator to create one multi-line text field.
 *
 *   mirror — optional plain fields (usage, spread #, status…) written for
 *     people looking at assets in Elvis itself, and read once when a shot is
 *     first pulled, if the asset carries values but no record yet. Never used
 *     to overwrite work once a record exists — plain fields carry no stamps,
 *     so they can't say whose change is newer.
 *
 * Every field name is a setting: Elvis custom fields are named per
 * installation, and the panel lists the fields the server actually has.
 */

export interface ElvisMirrorMap {
  usage: string;
  shotType: string;
  magSpread: string;
  prSlide: string;
  magRetoucher: string;
  prRetoucher: string;
  magStatus: string;
  prStatus: string;
}

export const MIRROR_LABELS: Record<keyof ElvisMirrorMap, string> = {
  usage: 'Usage (mag / pr / both)',
  shotType: 'Shot type',
  magSpread: 'Magazine spread #',
  prSlide: 'Press release slide #',
  magRetoucher: 'Magazine retoucher',
  prRetoucher: 'Press release retoucher',
  magStatus: 'Magazine status (written only)',
  prStatus: 'Press release status (written only)',
};

/** Mirror fields read on first pull; the two status fields are output only. */
export const MIRROR_READABLE: Array<keyof ElvisMirrorMap> = [
  'usage',
  'shotType',
  'magSpread',
  'prSlide',
  'magRetoucher',
  'prRetoucher',
];

export type ElvisAuthMode = 'login' | 'apikey' | 'basic' | 'none';
export type ElvisSearchMethod = 'GET' | 'POST';

export interface ElvisConfig {
  /** Keep linked projects in sync automatically. */
  enabled: boolean;
  /** Seconds between automatic syncs. Edits also trigger one shortly after. */
  intervalSec: number;
  /** Base URL — the browser address works; `/services` is added. */
  endpoint: string;
  searchPath: string;
  updatePath: string;
  searchMethod: ElvisSearchMethod;
  /** Which assets belong to the shoot, e.g. a folder: ancestorPaths:"/Shoots/Gala". */
  query: string;
  authMode: ElvisAuthMode;
  /** Kept only in the desktop app's own encrypted config — never in a project or delta file. */
  apiKey: string;
  username: string;
  password: string;
  recordField: string;
  mirror: ElvisMirrorMap;
}

export const emptyMirror = (): ElvisMirrorMap => ({
  usage: '',
  shotType: '',
  magSpread: '',
  prSlide: '',
  magRetoucher: '',
  prRetoucher: '',
  magStatus: '',
  prStatus: '',
});

export const defaultElvisConfig: ElvisConfig = {
  enabled: true,
  intervalSec: 60,
  endpoint: '',
  searchPath: '/search',
  updatePath: '/update',
  searchMethod: 'POST',
  query: '',
  authMode: 'login',
  apiKey: '',
  username: '',
  password: '',
  recordField: '',
  mirror: emptyMirror(),
};

/** The field names version 0.1 shipped as guesses; carried forward only if someone changed them. */
const V01_GUESSES = new Set(['cf_usagePlacement', 'cf_shotType', 'cf_spreadNum', 'cf_slideNum']);

/** Accept a stored config from any version and fill in what's missing. */
export function normalizeElvisConfig(raw: unknown): ElvisConfig {
  const r = (raw ?? {}) as Partial<ElvisConfig> & { fieldMap?: Record<string, string> };
  const mirror = { ...emptyMirror(), ...(r.mirror ?? {}) };
  if (!r.mirror && r.fieldMap) {
    const keep = (v?: string) => (v && !V01_GUESSES.has(v) ? v : '');
    mirror.usage = keep(r.fieldMap.usage);
    mirror.shotType = keep(r.fieldMap.shotType);
    mirror.magSpread = keep(r.fieldMap.spread);
    mirror.prSlide = keep(r.fieldMap.slide);
  }
  const updatePath = r.updatePath || defaultElvisConfig.updatePath;
  return {
    ...defaultElvisConfig,
    ...r,
    enabled: r.enabled ?? defaultElvisConfig.enabled,
    intervalSec: Math.max(15, Number(r.intervalSec) || defaultElvisConfig.intervalSec),
    authMode: r.authMode === 'apikey' || r.authMode === 'basic' || r.authMode === 'none' ? r.authMode : 'login',
    updatePath,
    recordField: String(r.recordField ?? ''),
    mirror,
  };
}

export interface ElvisHit {
  id: string;
  name?: string;
  thumbnailUrl?: string;
  previewUrl?: string;
  metadata: Record<string, unknown>;
}

export interface ElvisRequestResult {
  ok: boolean;
  status?: number;
  /** Which step failed: address, login, search, update. */
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

export interface ElvisSampleField {
  name: string;
  sample: string;
}

export interface ElvisTestResult {
  ok: boolean;
  steps: ElvisTestStep[];
  totalHits?: number;
  sampleFields?: ElvisSampleField[];
}

export interface ElvisSearchResult extends ElvisRequestResult {
  hits?: ElvisHit[];
  totalHits?: number;
  truncated?: boolean;
}

export interface ElvisImageResult extends ElvisRequestResult {
  bytes?: Uint8Array;
  mime?: string;
}
