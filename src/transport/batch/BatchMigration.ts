import { generateUUID } from '@datadog/browser-core';
import fs from 'node:fs/promises';
import path from 'node:path';
import { monitor } from '../../domain/telemetry';
import { display } from '../../tools/display';
import type { PendingBatchStore } from './PendingBatchStore';
import { evictBatchFiles } from './batchFileEviction';
import { AUTHORIZED_PENDING_DIRECTORY_PREFIX, PENDING_DIRECTORY_PREFIX } from './batchPaths';

/**
 * Moves or deletes stores whose pending period has ended, retaining failures for retry.
 * Authorized data keeps its approval across subsequent consent changes.
 * An atomic rename to `authorized-pending-*` records authorization on disk before files are moved.
 */
export class BatchMigration {
  private readonly jobs = new Map<string, MigrationJob>();
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly trackPath: string) {}

  authorize(store: PendingBatchStore): void {
    this.schedule({
      store,
      decision: 'authorize',
      authorizedPath: path.join(this.trackPath, `${AUTHORIZED_PENDING_DIRECTORY_PREFIX}${generateUUID()}`),
    });
  }

  discard(store: PendingBatchStore): void {
    this.schedule({ store, decision: 'discard' });
  }

  /** Retries unfinished decisions and recovers authorized batches from previous processes. */
  flush(): Promise<void> {
    return this.enqueue(async () => {
      for (const job of [...this.jobs.values()]) {
        await this.runJob(job);
      }
      await this.recoverAuthorizedDirectories();
      await this.evictPendingOverflow();
    });
  }

  /** Removes undecided periods from the previous process without deleting authorized batches. */
  static async clearPendingData(trackPath: string): Promise<void> {
    for (const entry of await readDirectories(trackPath)) {
      if (entry.name.startsWith(PENDING_DIRECTORY_PREFIX)) {
        await fs.rm(path.join(trackPath, entry.name), { recursive: true, force: true });
      }
    }
  }

  private schedule(job: MigrationJob): void {
    // Keep the first grant or refusal; later consent changes do not apply to this store.
    if (this.jobs.has(job.store.path)) {
      return;
    }
    job.store.close();
    this.jobs.set(job.store.path, job);
    void this.enqueue(() => this.runJob(job));
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    this.queue = this.queue
      .then(monitor(operation))
      .catch(monitor((error) => display.error('Failed to manage pending batches', error)));
    return this.queue;
  }

  private async runJob(job: MigrationJob): Promise<void> {
    if (this.jobs.get(job.store.path) !== job) {
      return;
    }
    try {
      await job.store.flush();
      if (job.decision === 'discard') {
        await fs.rm(job.store.path, { recursive: true, force: true });
      } else {
        await fs.mkdir(this.trackPath, { recursive: true });
        try {
          await fs.rename(job.store.path, job.authorizedPath);
        } catch (error) {
          if (!isMissingPath(error)) {
            throw error;
          }
        }
        await migrateAuthorizedDirectory(job.authorizedPath, this.trackPath);
      }
      this.jobs.delete(job.store.path);
    } catch (error) {
      display.error('Failed to migrate pending batches', error);
    }
  }

  private async recoverAuthorizedDirectories(): Promise<void> {
    const activeAuthorizedPaths = new Set(
      [...this.jobs.values()].flatMap((job) => (job.decision === 'authorize' ? [job.authorizedPath] : []))
    );
    for (const entry of await readDirectories(this.trackPath)) {
      const authorizedPath = path.join(this.trackPath, entry.name);
      if (entry.name.startsWith(AUTHORIZED_PENDING_DIRECTORY_PREFIX) && !activeAuthorizedPaths.has(authorizedPath)) {
        try {
          await migrateAuthorizedDirectory(authorizedPath, this.trackPath);
        } catch (error) {
          display.error('Failed to recover authorized batches', error);
        }
      }
    }
  }

  private async evictPendingOverflow(): Promise<void> {
    const directories = (await readDirectories(this.trackPath))
      .filter(
        (entry) =>
          entry.name.startsWith(PENDING_DIRECTORY_PREFIX) || entry.name.startsWith(AUTHORIZED_PENDING_DIRECTORY_PREFIX)
      )
      .map((entry) => path.join(this.trackPath, entry.name));
    await evictBatchFiles(directories);
  }
}

type MigrationJob =
  | { readonly store: PendingBatchStore; readonly decision: 'authorize'; readonly authorizedPath: string }
  | { readonly store: PendingBatchStore; readonly decision: 'discard' };

async function readDirectories(directory: string) {
  try {
    return (await fs.readdir(directory, { withFileTypes: true })).filter((entry) => entry.isDirectory());
  } catch (error) {
    if (isMissingPath(error)) {
      return [];
    }
    throw error;
  }
}

async function migrateAuthorizedDirectory(authorizedPath: string, trackPath: string): Promise<void> {
  let files;
  try {
    files = (await fs.readdir(authorizedPath)).filter((file) => /\.(?:log|tmp)$/.test(file));
  } catch (error) {
    if (isMissingPath(error)) {
      return;
    }
    throw error;
  }
  const migrationId = path.basename(authorizedPath).slice(AUTHORIZED_PENDING_DIRECTORY_PREFIX.length);
  for (const file of files) {
    // Avoid overwriting other producers' batches and keep destinations stable across retries.
    await fs.rename(path.join(authorizedPath, file), path.join(trackPath, `${file}-pending-${migrationId}.log`));
  }
  await fs.rm(authorizedPath, { recursive: true, force: true });
}

function isMissingPath(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
