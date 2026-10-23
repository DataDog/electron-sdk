import fs from 'node:fs/promises';
import path from 'node:path';
import { compareBatchFileNames } from './batchFileName';

export const MAX_BATCH_FILES = 100;

/** Best-effort cap on completed batches across directories; open `.tmp` files are left untouched. */
export async function evictBatchFiles(directories: readonly string[], maxFiles = MAX_BATCH_FILES): Promise<void> {
  const batches = (await Promise.all(directories.map(readBatchFiles))).flat();
  batches.sort((a, b) => compareBatchFileNames(path.basename(a), path.basename(b)));

  const overflow = batches.length - maxFiles;
  for (let i = 0; i < overflow; i++) {
    await fs.unlink(batches[i]).catch(() => undefined);
  }
}

async function readBatchFiles(directory: string): Promise<string[]> {
  try {
    return (await fs.readdir(directory))
      .filter((file) => file.endsWith('.log'))
      .map((file) => path.join(directory, file));
  } catch {
    return [];
  }
}
