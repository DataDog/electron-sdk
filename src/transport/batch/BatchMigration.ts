import { generateUUID } from '@datadog/browser-core';
import fs from 'node:fs/promises';
import path from 'node:path';
import { monitor } from '../../domain/telemetry';
import { display } from '../../tools/display';
import type { BatchProducer } from './BatchProducer';
import { evictBatchFiles } from './batchFileEviction';
import { AUTHORIZED_PENDING_DIRECTORY_PREFIX, PENDING_DIRECTORY_PREFIX } from './batchPaths';

/** One pending period's directory and writer; later periods never write here. */
export interface PendingBatchStore {
  readonly path: string;
  /** Undefined if directory creation failed; no events could be written to this store. */
  readonly producer: Promise<BatchProducer | undefined>;
}

/**
 * Moves or deletes stores whose pending period has ended, retaining failures for retry.
 * Authorized data keeps its approval across subsequent consent changes.
 * An atomic rename to `.authorized-pending-*` records authorization on disk before files are moved.
 */
export class BatchMigration {
  private readonly jobs = new Map<string, MigrationJob>();
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly authorizedPath: string) {}

  authorize(store: PendingBatchStore): void {
    this.schedule({
      store,
      decision: 'authorize',
      stagingPath: path.join(this.authorizedPath, `${AUTHORIZED_PENDING_DIRECTORY_PREFIX}${generateUUID()}`),
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
      if (entry.name === 'pending' || entry.name.startsWith(PENDING_DIRECTORY_PREFIX)) {
        await fs.rm(path.join(trackPath, entry.name), { recursive: true, force: true });
      }
    }
  }

  private schedule(job: MigrationJob): void {
    // Keep the first grant or refusal; later consent changes do not apply to this store.
    if (this.jobs.has(job.store.path)) {
      return;
    }
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
      const producer = await job.store.producer;
      if (producer) {
        await producer.flush();
      }
      if (job.decision === 'discard') {
        await fs.rm(job.store.path, { recursive: true, force: true });
      } else {
        await fs.mkdir(this.authorizedPath, { recursive: true });
        try {
          await fs.rename(job.store.path, job.stagingPath);
        } catch (error) {
          if (!isMissingPath(error)) {
            throw error;
          }
        }
        await migrateAuthorizedDirectory(job.stagingPath, this.authorizedPath);
      }
      this.jobs.delete(job.store.path);
    } catch (error) {
      display.error('Failed to migrate pending batches', error);
    }
  }

  private async recoverAuthorizedDirectories(): Promise<void> {
    const activeStagingPaths = new Set(
      [...this.jobs.values()].flatMap((job) => (job.decision === 'authorize' ? [job.stagingPath] : []))
    );
    for (const entry of await readDirectories(this.authorizedPath)) {
      const stagingPath = path.join(this.authorizedPath, entry.name);
      if (entry.name.startsWith(AUTHORIZED_PENDING_DIRECTORY_PREFIX) && !activeStagingPaths.has(stagingPath)) {
        try {
          await migrateAuthorizedDirectory(stagingPath, this.authorizedPath);
        } catch (error) {
          display.error('Failed to recover authorized batches', error);
        }
      }
    }
  }

  private async evictPendingOverflow(): Promise<void> {
    const directories = (await readDirectories(this.authorizedPath))
      .filter(
        (entry) =>
          entry.name.startsWith(PENDING_DIRECTORY_PREFIX) || entry.name.startsWith(AUTHORIZED_PENDING_DIRECTORY_PREFIX)
      )
      .map((entry) => path.join(this.authorizedPath, entry.name));
    await evictBatchFiles(directories);
  }
}

type MigrationJob =
  | { readonly store: PendingBatchStore; readonly decision: 'authorize'; readonly stagingPath: string }
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

async function migrateAuthorizedDirectory(stagingPath: string, authorizedPath: string): Promise<void> {
  let files;
  try {
    files = (await fs.readdir(stagingPath)).filter((file) => /\.(?:log|tmp)$/.test(file));
  } catch (error) {
    if (isMissingPath(error)) {
      return;
    }
    throw error;
  }
  const migrationId = path.basename(stagingPath).slice(AUTHORIZED_PENDING_DIRECTORY_PREFIX.length);
  for (const file of files) {
    // Avoid overwriting other producers' batches and keep destinations stable across retries.
    await fs.rename(path.join(stagingPath, file), path.join(authorizedPath, `${file}-pending-${migrationId}.log`));
  }
  await fs.rm(stagingPath, { recursive: true, force: true });
}

function isMissingPath(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
