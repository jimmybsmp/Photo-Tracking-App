import { useCallback, useState } from 'react';
import { importImageFile } from '@/lib/images';
import { toast } from '@/lib/toast';
import { useTrackerStore } from '@/state/useTrackerStore';
import type { AssetMeta } from '@/state/schema';

const IMPORT_CONCURRENCY = 4;

export interface ImportProgress {
  done: number;
  total: number;
}

/**
 * Photo import: resize and hash every image (lib/images.ts), a few at a time,
 * then hand the finished set to the store in one batch — so undo treats
 * "imported 40 photos" as one step, not forty.
 */
export function useFileImport() {
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const addRowsFromAssets = useTrackerStore((s) => s.addRowsFromAssets);
  const assignImage = useTrackerStore((s) => s.assignImage);

  const importFiles = useCallback(
    async (fileList: FileList | File[]) => {
      const files = Array.from(fileList).filter((f) => f.type.startsWith('image/'));
      if (files.length === 0) {
        toast('No photos in that drop — PhotoTrack imports JPEG, PNG and similar image files.', 'bad');
        return;
      }

      setProgress({ done: 0, total: files.length });
      const results: Array<AssetMeta | null> = new Array(files.length).fill(null);
      let next = 0;
      let finished = 0;
      let failed = 0;
      const worker = async () => {
        while (next < files.length) {
          const i = next++;
          try {
            results[i] = await importImageFile(files[i]);
          } catch {
            failed++;
          }
          setProgress({ done: ++finished, total: files.length });
        }
      };
      await Promise.all(Array.from({ length: Math.min(IMPORT_CONCURRENCY, files.length) }, worker));
      const assets = results.filter((a): a is AssetMeta => a !== null);
      const created = addRowsFromAssets(assets);
      setProgress(null);

      const skipped = assets.length - created.length;
      const parts = [`Added ${created.length} shot${created.length === 1 ? '' : 's'}`];
      if (skipped) parts.push(`${skipped} already tracked`);
      if (failed) parts.push(`${failed} couldn't be read`);
      toast(parts.join(' · '), failed ? 'bad' : 'good');
    },
    [addRowsFromAssets],
  );

  /** Replace one shot's photo. */
  const importInto = useCallback(
    async (rowId: string, file: File | undefined) => {
      if (!file || !file.type.startsWith('image/')) return;
      try {
        assignImage(rowId, await importImageFile(file));
      } catch {
        toast(`Couldn't read ${file.name}`, 'bad');
      }
    },
    [assignImage],
  );

  return { importFiles, importInto, progress };
}
