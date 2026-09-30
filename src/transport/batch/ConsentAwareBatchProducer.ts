import { generateUUID, type Subscription } from '@datadog/browser-core';
import path from 'node:path';
import type { TrackingConsentChange, TrackingConsentManager } from '../../domain/tracking-consent';
import { monitor } from '../../domain/telemetry';
import type { ServerEvent } from '../../event';
import { display } from '../../tools/display';
import type { BatchProducer } from './BatchProducer';
import { BatchMigration, type PendingBatchStore } from './BatchMigration';
import { PENDING_DIRECTORY_PREFIX } from './batchPaths';

/**
 * Routes events to authorized storage or the current pending store.
 * A pending period starts on entering `pending` and ends at the next consent change.
 * Each period owns its directory; BatchMigration handles the grant or refusal when it ends.
 */
export class ConsentAwareBatchProducer {
  private readonly subscription: Subscription;
  private readonly migration: BatchMigration;
  private pendingStore: PendingBatchStore | undefined;

  constructor(
    private readonly authorizedProducer: BatchProducer,
    private readonly authorizedPath: string,
    private readonly createProducer: (directory: string) => Promise<BatchProducer>,
    private readonly consentManager: TrackingConsentManager
  ) {
    this.migration = new BatchMigration(authorizedPath);
    if (consentManager.get() === 'pending') {
      this.pendingStore = this.createPendingStore();
    }
    this.subscription = consentManager.subscribe((change) => this.onConsentChange(change));
  }

  /** Selects the store now, so asynchronous creation cannot assign an event to a later consent period. */
  post(event: ServerEvent): void {
    if (this.consentManager.get() === 'granted') {
      this.authorizedProducer.post(event);
    } else if (this.pendingStore) {
      void this.pendingStore.producer.then(
        monitor((producer: BatchProducer | undefined) => {
          if (producer) producer.post(event);
        })
      );
    }
  }

  private onConsentChange(change: TrackingConsentChange): void {
    const previousStore = this.pendingStore;
    this.pendingStore = change.current === 'pending' ? this.createPendingStore() : undefined;
    if (previousStore) {
      if (change.current === 'granted') {
        this.migration.authorize(previousStore);
      } else {
        this.migration.discard(previousStore);
      }
    }
  }

  private createPendingStore(
    directory = path.join(this.authorizedPath, `${PENDING_DIRECTORY_PREFIX}${generateUUID()}`)
  ): PendingBatchStore {
    const producer = this.createProducer(directory).catch(
      monitor((error) => {
        display.error('Failed to create pending batch storage', error);
        return undefined;
      })
    );
    return { path: directory, producer };
  }

  /** Seals current batches and retries old migrations without blocking authorized uploads on their failures. */
  async flush(): Promise<void> {
    const pendingStore = this.pendingStore;
    let pendingProducer = await pendingStore?.producer;
    // Retry failed creation only while this period still accepts events, never after its decision.
    if (pendingStore && !pendingProducer && this.pendingStore === pendingStore) {
      this.pendingStore = this.createPendingStore(pendingStore.path);
      pendingProducer = await this.pendingStore.producer;
    }
    if (pendingProducer) {
      await pendingProducer.flush().catch(monitor((error) => display.error('Failed to flush pending batches', error)));
    }
    await this.migration.flush();
    await this.authorizedProducer.flush();
  }

  /** Releases the consent subscription. Previously accepted writes and migrations may still finish. */
  stop(): void {
    this.subscription.unsubscribe();
  }
}
