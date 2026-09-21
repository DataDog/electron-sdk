import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const AUTHORIZED_PENDING_PREFIX = '.authorized-pending-';

/** Remove storage left by a previous process. Pending consent itself is intentionally not persisted. */
export async function clearBatchDirectory(directory: string): Promise<void> {
  await fs.rm(directory, { recursive: true, force: true });
}

/**
 * Move pending batches into authorized storage. The producer is flushed before this runs, so a `.tmp`
 * file here is a complete batch whose final rotation rename failed and must be preserved as well.
 * A unique suffix prevents overwriting an authorized batch when independent producers happened to
 * generate the same timestamp/sequence name.
 */
export async function authorizePendingBatches(pendingPath: string, authorizedPath: string): Promise<void> {
  await fs.mkdir(authorizedPath, { recursive: true });
  const stagingPath = path.join(authorizedPath, `${AUTHORIZED_PENDING_PREFIX}${randomUUID()}`);
  try {
    // Detach the granted interval atomically before moving individual files. A later pending clear can
    // now safely reuse `pendingPath` without deleting files that were already authorized.
    await fs.rename(pendingPath, stagingPath);
  } catch (error) {
    if (!isMissingPath(error)) {
      throw error;
    }
  }
  await recoverAuthorizedPendingBatches(authorizedPath);
}

/** Retry files from granted intervals that were detached before a partial migration failure or crash. */
export async function recoverAuthorizedPendingBatches(authorizedPath: string): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(authorizedPath, { withFileTypes: true });
  } catch (error) {
    if (isMissingPath(error)) {
      return;
    }
    throw error;
  }

  for (const entry of entries) {
    if (entry.isDirectory() && entry.name.startsWith(AUTHORIZED_PENDING_PREFIX)) {
      await migrateAuthorizedDirectory(
        path.join(authorizedPath, entry.name),
        authorizedPath,
        entry.name.slice(AUTHORIZED_PENDING_PREFIX.length)
      );
    }
  }
}

async function migrateAuthorizedDirectory(
  stagingPath: string,
  authorizedPath: string,
  migrationId: string
): Promise<void> {
  const files = (await fs.readdir(stagingPath)).filter((file) => /\.(?:log|tmp)$/.test(file));
  for (const [index, file] of files.entries()) {
    const source = path.join(stagingPath, file);
    // Pending and authorized producers have independent filename sequences. Always move into a
    // namespace the authorized producer cannot generate: checking whether the original destination
    // exists before renaming would be racy and POSIX rename() can silently overwrite a file created
    // between that check and the move. Keeping the original name as the prefix preserves age sorting.
    const destination = path.join(
      authorizedPath,
      file.replace(/\.(?:log|tmp)$/, `-pending-${migrationId}-${index + 1}.log`)
    );

    // A failed rename leaves the source in pending storage so a later granted upload cycle can retry.
    // Let the failure propagate so the SDK reports it instead of silently stranding authorized data.
    await fs.rename(source, destination);
  }
  await fs.rm(stagingPath, { recursive: true, force: true });
}

function isMissingPath(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
