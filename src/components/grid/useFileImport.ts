import { useCallback, useState } from 'react';
import { importImageFile } from '@/lib/images';
import { useTrackerStore } from '@/state/useTrackerStore';

export interface ImportProgress {
  done: number;
  total: number;
}

/**
 * Shared multi-file import: reads every dropped/selected image, resizes and
 * hashes it (see lib/images.ts), then hands the finished assets to the store
 * in one batch so undo captures "imported 40 photos" as one step, not forty.
 */
export function useFileImport() {
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const [lastSkipped, setLastSkipped] = useState(0);
  const addRowsFromAssets = useTrackerStore((s) => s.addRowsFromAssets);

  const importFiles = useCallback(
    async (fileList: FileList | File[]) => {
      const files = Array.from(fileList).filter((f) => f.type.startsWith('image/'));
      if (files.length === 0) return;

      setProgress({ done: 0, total: files.length });
      const assets = [];
      for (let i = 0; i < files.length; i++) {
        try {
          assets.push(await importImageFile(files[i]));
        } catch (err) {
          console.warn('Could not import image', files[i].name, err);
        }
        setProgress({ done: i + 1, total: files.length });
      }

      const created = addRowsFromAssets(assets);
      setLastSkipped(assets.length - created.length);
      setProgress(null);
    },
    [addRowsFromAssets],
  );

  return { importFiles, progress, lastSkipped };
}
