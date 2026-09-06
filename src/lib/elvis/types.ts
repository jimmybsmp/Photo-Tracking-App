/**
 * WoodWing Elvis sync — configuration shape.
 *
 * Nothing here is guessed at runtime: every endpoint, path, HTTP method, and
 * metadata field name is a setting, because Elvis/Assets deployments differ
 * enough between installs (self-hosted version, custom field naming, auth
 * scheme) that hardcoding any of it would just be swapping one set of wrong
 * assumptions for another. The defaults below match what the tool this
 * replaces guessed at — plausible field names, nothing confirmed against a
 * real server — and are meant to be overwritten from the panel once someone
 * who administers the DAM can confirm the real ones.
 */

export interface ElvisFieldMap {
  usage: string;
  shotType: string;
  spread: string;
  slide: string;
  retouched: string;
  qc: string;
  assembled: string;
  submitted: string;
  approved: string;
}

export const DEFAULT_ELVIS_FIELD_MAP: ElvisFieldMap = {
  usage: 'cf_usagePlacement',
  shotType: 'cf_shotType',
  spread: 'cf_spreadNum',
  slide: 'cf_slideNum',
  retouched: 'cf_retouched',
  qc: 'cf_qcOk',
  assembled: 'cf_assembled',
  submitted: 'cf_submitted',
  approved: 'cf_approved',
};

export type ElvisAuthMode = 'none' | 'apikey' | 'basic';
export type ElvisSearchMethod = 'GET' | 'POST';

export interface ElvisConfig {
  enabled: boolean;
  /** Base URL, e.g. https://dam.company.com/services */
  endpoint: string;
  searchPath: string;
  updatePath: string;
  searchMethod: ElvisSearchMethod;
  query: string;
  authMode: ElvisAuthMode;
  /** Kept only in the desktop app's local config file — never in the
   *  project file, never in a delta, never synced to a peer. */
  apiKey: string;
  username: string;
  password: string;
  fieldMap: ElvisFieldMap;
}

export const defaultElvisConfig: ElvisConfig = {
  enabled: false,
  endpoint: '',
  searchPath: '/search',
  updatePath: '/updatebulk',
  searchMethod: 'POST',
  query: '',
  authMode: 'none',
  apiKey: '',
  username: '',
  password: '',
  fieldMap: { ...DEFAULT_ELVIS_FIELD_MAP },
};

export interface ElvisHit {
  id: string;
  name?: string;
  thumbnailUrl?: string;
  metadata: Record<string, unknown>;
}

export interface ElvisRequestResult {
  ok: boolean;
  status?: number;
  body?: unknown;
  error?: string;
}
