import { generateUUID } from '@datadog/browser-core';
import fs from 'node:fs/promises';
import path from 'node:path';

const AUTHORIZED_PENDING_PREFIX = '.authorized-pending-';

/** Remove pending batches when consent is rejected or a new process starts. */
export async function clearBatchDirectory(directory: string): Promise<void> {
  await fs.rm(directory, { recursive: true, force: true });
}

/**
 * Move pending batches into authorized storage after the producer has been flushed. A remaining `.tmp`
 * file is a complete batch whose rotation failed and must also be preserved.
 */
export async function authorizePendingBatches(pendingPath: string, authorizedPath: string): Promise<void> {
  await fs.mkdir(authorizedPath, { recursive: true });
  const stagingPath = path.join(authorizedPath, `${AUTHORIZED_PENDING_PREFIX}${generateUUID()}`);
  try {
    // Detach the authorized interval before moving individual files so clearing a later pending
    // interval cannot delete files that were already authorized.
    await fs.rename(pendingPath, stagingPath);
  } catch (error) {
    if (!isMissingPath(error)) {
      throw error;
    }
  }
  await recoverAuthorizedPendingBatches(authorizedPath);
}

/** Retry authorized files left in detached storage after a migration failure or process restart. */
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
  for (const file of files) {
    const source = path.join(stagingPath, file);
    // Independent producers can generate identical names. Keep the full source name and migration ID
    // in a separate namespace, stable across retries, without a racy destination existence check.
    const destination = path.join(authorizedPath, `${file}-pending-${migrationId}.log`);
    await fs.rename(source, destination);
  }
  // A failed move throws before removal, leaving the remaining authorized files available for retry.
  await fs.rm(stagingPath, { recursive: true, force: true });
}

function isMissingPath(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
