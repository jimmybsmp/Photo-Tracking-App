import { hashBytes } from './compat';
import type { AssetMeta } from '@/state/schema';

/**
 * Image import and the asset store.
 *
 * The old tool stored one full-resolution image per row, inline, in a single
 * JSON blob — a 24MP JPEG lands around 8MB, ~11MB again once base64 encoded,
 * and localStorage's whole quota is about 5MB. That is the "dies after one
 * photo" failure. This fixes it two ways: every image is resized down to what
 * the app actually displays before it is stored, and images are content-
 * addressed by hash so re-dropping a frame you already imported — or pulling
 * one back in from a peer's delta file — costs nothing extra.
 *
 * Two sizes are kept per asset: a small thumbnail for the grid (hundreds of
 * these have to paint at once) and a larger review size for the inspector and
 * the printed sheet. Neither needs the original megapixel count.
 */

const THUMB_EDGE = 360;
const REVIEW_EDGE = 1600;
const REVIEW_QUALITY = 0.85;
const THUMB_QUALITY = 0.8;

function readAsDataUrl(file: File | Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('Could not read the file'));
    reader.readAsDataURL(file);
  });
}

function readAsArrayBuffer(file: File | Blob): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error ?? new Error('Could not read the file'));
    reader.readAsArrayBuffer(file);
  });
}

function loadImageEl(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Could not decode the image'));
    image.src = dataUrl;
  });
}

function resize(image: HTMLImageElement, maxEdge: number, quality: number, keepAlpha: boolean): string {
  const longest = Math.max(image.naturalWidth, image.naturalHeight);
  const scale = longest > maxEdge ? maxEdge / longest : 1;
  const width = Math.max(1, Math.round(image.naturalWidth * scale));
  const height = Math.max(1, Math.round(image.naturalHeight * scale));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return image.src;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(image, 0, 0, width, height);
  return keepAlpha ? canvas.toDataURL('image/png') : canvas.toDataURL('image/jpeg', quality);
}

function dataUrlBytes(dataUrl: string): number {
  const comma = dataUrl.indexOf(',');
  if (comma < 0) return 0;
  return Math.round((dataUrl.length - comma - 1) * 0.75);
}

/**
 * Import one file into an `AssetMeta`, already deduped by content hash — the
 * caller decides what to do when the hash already exists in the document
 * (nothing; the row just points at the existing entry).
 */
export async function importImageFile(file: File): Promise<AssetMeta> {
  const buffer = await readAsArrayBuffer(file);
  const hash = await hashBytes(buffer);
  const original = await readAsDataUrl(new Blob([buffer], { type: file.type }));
  const image = await loadImageEl(original);
  const keepAlpha = file.type === 'image/png' || file.type === 'image/webp';

  const reviewUrl = resize(image, REVIEW_EDGE, REVIEW_QUALITY, keepAlpha);
  const thumbUrl = resize(image, THUMB_EDGE, THUMB_QUALITY, keepAlpha);

  return {
    hash,
    thumbUrl,
    reviewUrl,
    width: image.naturalWidth,
    height: image.naturalHeight,
    fileName: file.name,
    bytes: dataUrlBytes(thumbUrl) + dataUrlBytes(reviewUrl),
  };
}

/**
 * The same import, starting from a data URL already in memory — used by the
 * legacy-file migration, which has the old tool's raw embedded image but no
 * `File` object to read it from.
 */
export async function importImageDataUrl(dataUrl: string, fileName: string): Promise<AssetMeta> {
  const comma = dataUrl.indexOf(',');
  const mimeMatch = /data:([^;]+);/.exec(dataUrl);
  const mime = mimeMatch?.[1] ?? 'image/jpeg';
  const binary = atob(dataUrl.slice(comma + 1));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

  const hash = await hashBytes(bytes.buffer);
  const image = await loadImageEl(dataUrl);
  const keepAlpha = mime === 'image/png' || mime === 'image/webp';

  const reviewUrl = resize(image, REVIEW_EDGE, REVIEW_QUALITY, keepAlpha);
  const thumbUrl = resize(image, THUMB_EDGE, THUMB_QUALITY, keepAlpha);

  return {
    hash,
    thumbUrl,
    reviewUrl,
    width: image.naturalWidth,
    height: image.naturalHeight,
    fileName,
    bytes: dataUrlBytes(thumbUrl) + dataUrlBytes(reviewUrl),
  };
}

/** Extract a likely shot/camera-file number from a filename, e.g. IMG_4821 → 4821. */
export function extractShotNumber(fileName: string): string {
  const stem = fileName.replace(/\.[^/.]+$/, '');
  const cameraPattern = /([0-9]{2}[A-Z][0-9]{4}|[A-Z0-9]+_[0-9]{4}|img_?[0-9]{4}|[0-9]{4})$/i;
  const match = stem.match(cameraPattern);
  if (match) return match[0].toUpperCase();
  const parts = stem.split('_');
  return parts[parts.length - 1].toUpperCase();
}

/** Human-readable aspect ratio label for a badge, e.g. "3:2 Aspect". */
export function aspectLabel(width: number, height: number): string {
  const ratio = width / height;
  const table: Array<[number, string]> = [
    [1.5, '3:2'], [1.777, '16:9'], [1.25, '5:4'], [1.333, '4:3'],
    [1.0, '1:1'], [0.8, '4:5'], [0.666, '2:3'],
  ];
  for (const [target, label] of table) {
    if (Math.abs(ratio - target) < 0.08) return label;
  }
  return `${width}×${height}`;
}
