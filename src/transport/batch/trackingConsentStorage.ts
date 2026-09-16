import fs from 'node:fs/promises';
import path from 'node:path';

/** Remove storage left by a previous process. Pending consent itself is intentionally not persisted. */
export async function clearBatchDirectory(directory: string): Promise<void> {
  await fs.rm(directory, { recursive: true, force: true });
}

/**
 * Move completed pending batches into authorized storage. A unique suffix prevents overwriting an
 * authorized batch when independent producers happened to generate the same timestamp/sequence name.
 */
export async function authorizePendingBatches(pendingPath: string, authorizedPath: string): Promise<void> {
  const files = (await fs.readdir(pendingPath)).filter((file) => file.endsWith('.log'));

  await fs.mkdir(authorizedPath, { recursive: true });
  const migrationId = Date.now();
  for (const [index, file] of files.entries()) {
    const source = path.join(pendingPath, file);
    // Pending and authorized producers have independent filename sequences. Always move into a
    // namespace the authorized producer cannot generate: checking whether the original destination
    // exists before renaming would be racy and POSIX rename() can silently overwrite a file created
    // between that check and the move. Keeping the original name as the prefix preserves age sorting.
    const destination = path.join(authorizedPath, file.replace(/\.log$/, `-pending-${migrationId}-${index + 1}.log`));

    // A failed rename leaves the source in pending storage so a later granted upload cycle can retry.
    // Let the failure propagate so the SDK reports it instead of silently stranding authorized data.
    await fs.rename(source, destination);
  }
}
