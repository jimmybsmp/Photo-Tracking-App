import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import { migrate, type AssetMeta, type PendingImage, type TrackerDocument } from '@/state/schema';
import { isDeltaFile, type DeltaFile } from './delta';
import { importImageDataUrl } from './images';
import { desktop } from './desktop';

/**
 * Reading and writing project files.
 *
 * A `.phototrack` file is a zip: `document.json` (every row, in full) plus
 * one thumbnail and one review-size image per distinct asset, stored as real
 * binary JPEG/PNG rather than base64 text. That is the fix for "saved with
 * lots of images" — base64 in JSON was both a third again larger and forced
 * the whole project through `JSON.stringify` as one string on every save.
 * Here the image bytes never touch a string; only `document.json` does, and
 * it holds nothing but small text fields plus one hash per row.
 *
 * The format is the same in the desktop app and the standalone build,
 * deliberately, same reasoning as OpticPlan: a project drafted on an
 * air-gapped machine has to open unmodified on the networked one.
 */

const EXT_FROM_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};
const MIME_FROM_EXT: Record<string, string> = {
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
};

function dataUrlToBytes(dataUrl: string): { mime: string; bytes: Uint8Array } {
  const match = /^data:([^;]+);base64,([\s\S]*)$/.exec(dataUrl);
  if (!match) return { mime: 'application/octet-stream', bytes: new Uint8Array() };
  const binary = atob(match[2]);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return { mime: match[1], bytes };
}

/** Chunked to avoid blowing the call-stack `String.fromCharCode` hits on a big array. */
function bytesToDataUrl(bytes: Uint8Array, mime: string): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return `data:${mime};base64,${btoa(binary)}`;
}

export const safeName = (name: string) =>
  (name || 'Photo_Tracker').replace(/[^a-z0-9]/gi, '_').replace(/_+/g, '_') || 'Photo_Tracker';

export function suggestedFileName(doc: TrackerDocument, ext: string): string {
  const event = safeName(doc.header.event);
  const stamp = new Date().toISOString().split('T')[0];
  return `${event}_${stamp}${ext}`;
}

/* ------------------------------------------------------------------ *
 * Packing
 * ------------------------------------------------------------------ */

interface AssetManifestEntry {
  hash: string;
  width: number;
  height: number;
  fileName: string;
  bytes: number;
  thumbExt: string;
  reviewExt: string;
}

/**
 * Split an asset map into zip file entries (real binary images) plus a
 * lightweight manifest to embed in the JSON — shared by the project file and
 * the delta file, since both bundle assets the same way.
 */
function packAssets(assets: TrackerDocument['assets']): {
  files: Record<string, Uint8Array>;
  manifest: Record<string, AssetManifestEntry>;
} {
  const files: Record<string, Uint8Array> = {};
  const manifest: Record<string, AssetManifestEntry> = {};

  for (const hash in assets) {
    const asset = assets[hash];
    const thumb = dataUrlToBytes(asset.thumbUrl);
    const review = dataUrlToBytes(asset.reviewUrl);
    const thumbExt = EXT_FROM_MIME[thumb.mime] ?? 'bin';
    const reviewExt = EXT_FROM_MIME[review.mime] ?? 'bin';
    files[`assets/${hash}.thumb.${thumbExt}`] = thumb.bytes;
    files[`assets/${hash}.review.${reviewExt}`] = review.bytes;
    manifest[hash] = {
      hash: asset.hash,
      width: asset.width,
      height: asset.height,
      fileName: asset.fileName,
      bytes: asset.bytes,
      thumbExt,
      reviewExt,
    };
  }
  return { files, manifest };
}

function unpackAssets(
  manifest: Record<string, AssetManifestEntry>,
  files: Record<string, Uint8Array>,
): TrackerDocument['assets'] {
  const assets: TrackerDocument['assets'] = {};
  for (const hash in manifest) {
    const meta = manifest[hash];
    const thumbBytes = files[`assets/${hash}.thumb.${meta.thumbExt}`];
    const reviewBytes = files[`assets/${hash}.review.${meta.reviewExt}`];
    assets[hash] = {
      hash,
      width: meta.width,
      height: meta.height,
      fileName: meta.fileName,
      bytes: meta.bytes,
      thumbUrl: thumbBytes ? bytesToDataUrl(thumbBytes, MIME_FROM_EXT[meta.thumbExt] ?? 'image/jpeg') : '',
      reviewUrl: reviewBytes ? bytesToDataUrl(reviewBytes, MIME_FROM_EXT[meta.reviewExt] ?? 'image/jpeg') : '',
    };
  }
  return assets;
}

/** Build the zip bytes for a document. */
export function packDocument(doc: TrackerDocument): Uint8Array {
  const { files, manifest } = packAssets(doc.assets);
  files['document.json'] = strToU8(JSON.stringify({ ...doc, assets: manifest }));
  return zipSync(files, { level: 6 });
}

/** Reconstruct a document (with live data-URL assets) from packed zip bytes. */
export function unpackDocument(bytes: Uint8Array): TrackerDocument {
  const files = unzipSync(bytes);
  const manifestBytes = files['document.json'];
  if (!manifestBytes) throw new Error('Not a PhotoTrack project file — missing document.json');

  const manifest = JSON.parse(strFromU8(manifestBytes)) as Record<string, unknown>;
  const { doc } = migrate(manifest);
  const manifestAssets = (manifest.assets ?? {}) as Record<string, AssetManifestEntry>;
  return { ...doc, assets: unpackAssets(manifestAssets, files) };
}

/** Build the zip bytes for a delta file (`.ptdelta`). */
export function packDelta(delta: DeltaFile): Uint8Array {
  const { files, manifest } = packAssets(delta.assets);
  files['delta.json'] = strToU8(JSON.stringify({ ...delta, assets: manifest }));
  return zipSync(files, { level: 6 });
}

/** Reconstruct a delta file from packed zip bytes. */
export function unpackDelta(bytes: Uint8Array): DeltaFile {
  const files = unzipSync(bytes);
  const manifestBytes = files['delta.json'];
  if (!manifestBytes) throw new Error('Not a PhotoTrack delta file — missing delta.json');

  const raw = JSON.parse(strFromU8(manifestBytes)) as Record<string, unknown>;
  if (!isDeltaFile(raw)) throw new Error('Not a PhotoTrack delta file');
  const manifestAssets = (raw.assets ?? {}) as unknown as Record<string, AssetManifestEntry>;
  return { ...raw, assets: unpackAssets(manifestAssets, files) };
}

/** A zip starts with a `PK` local-file-header signature; plain JSON does not. */
function looksLikeZip(bytes: Uint8Array): boolean {
  return bytes.length > 2 && bytes[0] === 0x50 && bytes[1] === 0x4b;
}

/** Resolve the legacy tool's inline images into real deduped, resized assets. */
async function resolvePendingImages(doc: TrackerDocument, pending: PendingImage[]): Promise<TrackerDocument> {
  if (pending.length === 0) return doc;
  const assets: Record<string, AssetMeta> = { ...doc.assets };
  const rows = { ...doc.rows };
  for (const p of pending) {
    try {
      const asset = await importImageDataUrl(p.dataUrl, p.fileName);
      assets[asset.hash] = asset;
      const row = rows[p.rowId];
      if (row) rows[p.rowId] = { ...row, imageHash: asset.hash };
    } catch {
      // A corrupt or unreadable embedded image should not fail the whole
      // import — that row just comes in without a picture.
    }
  }
  return { ...doc, rows, assets };
}

/** Parse whatever bytes a file picker or a drop handed us into a document. */
export async function parseProjectBytes(bytes: Uint8Array): Promise<TrackerDocument> {
  if (looksLikeZip(bytes)) return unpackDocument(bytes);

  const text = strFromU8(bytes);
  const raw = JSON.parse(text);
  const { doc, pending } = migrate(raw);
  return resolvePendingImages(doc, pending);
}

/* ------------------------------------------------------------------ *
 * Save / Open
 * ------------------------------------------------------------------ */

function downloadBytes(bytes: Uint8Array, filename: string) {
  const blob = new Blob([bytes as BlobPart], { type: 'application/zip' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

/**
 * Save the project.
 *
 * In the desktop app this writes back to the open file, or asks where to put
 * it the first time; `forceDialog` is Save As. In a browser it falls back to
 * a download, which lands wherever downloads land.
 */
export async function saveProject(doc: TrackerDocument, forceDialog = false): Promise<string | null> {
  const bytes = packDocument(doc);
  const name = suggestedFileName(doc, '.phototrack');

  const bridge = desktop();
  if (bridge) {
    const result = await bridge.save(bytes, name, forceDialog);
    if (result.ok) void bridge.clearRecovery();
    return result.ok ? (result.path ?? name) : null;
  }

  downloadBytes(bytes, name);
  return name;
}

/** Open a project. Returns null if cancelled. */
export async function openProject(): Promise<{ doc: TrackerDocument; path: string | null } | null> {
  const bridge = desktop();
  if (bridge) {
    const result = await bridge.openProject();
    if (!result.ok || !result.bytes) return null;
    try {
      const doc = await parseProjectBytes(result.bytes);
      return { doc, path: result.path ?? null };
    } catch {
      return null;
    }
  }

  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.phototrack,.json,application/zip,application/json';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return resolve(null);
      try {
        const buffer = new Uint8Array(await file.arrayBuffer());
        const doc = await parseProjectBytes(buffer);
        resolve({ doc, path: null });
      } catch {
        resolve(null);
      }
    };
    input.oncancel = () => resolve(null);
    input.click();
  });
}

/* ------------------------------------------------------------------ *
 * Delta files — how two units share progress without a server
 * ------------------------------------------------------------------ */

export function deltaFileName(doc: TrackerDocument): string {
  return suggestedFileName(doc, '.ptdelta');
}

/**
 * Export a delta as a file (Save dialog on desktop, a download in the
 * browser). This never touches the open project's own file or its recovery
 * slot — a delta is always a separate hand-off, not a save.
 */
export async function saveDelta(delta: DeltaFile, doc: TrackerDocument): Promise<string | null> {
  const bytes = packDelta(delta);
  const name = deltaFileName(doc);

  const bridge = desktop();
  if (bridge) {
    const result = await bridge.exportDelta(bytes, name);
    return result.ok ? (result.path ?? name) : null;
  }

  downloadBytes(bytes, name);
  return name;
}

/** Pick a delta file to import. Returns null if cancelled. */
export async function openDelta(): Promise<DeltaFile | null> {
  const bridge = desktop();
  if (bridge) {
    const result = await bridge.importDelta();
    if (!result.ok || !result.bytes) return null;
    try {
      return unpackDelta(result.bytes);
    } catch {
      return null;
    }
  }

  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.ptdelta,application/zip';
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) return resolve(null);
      file
        .arrayBuffer()
        .then((buf) => resolve(unpackDelta(new Uint8Array(buf))))
        .catch(() => resolve(null));
    };
    input.oncancel = () => resolve(null);
    input.click();
  });
}
