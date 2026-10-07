import type { Subscription } from '@datadog/browser-core';
import type { TrackingConsentChange, TrackingConsentManager } from '../../domain/tracking-consent';
import { monitor } from '../../domain/telemetry';
import type { ServerEvent } from '../../event';
import { display } from '../../tools/display';
import type { BatchProducer } from './BatchProducer';
import { BatchMigration } from './BatchMigration';
import { PendingBatchStore } from './PendingBatchStore';

/**
 * Routes events to authorized storage or the current pending store.
 * A pending period starts on entering `pending` and ends at the next consent change.
 * Each period owns its directory; BatchMigration handles the grant or refusal when it ends.
 */
export class ConsentAwareBatchRouter {
  private readonly subscription: Subscription;
  private readonly migration: BatchMigration;
  private pendingStore: PendingBatchStore | undefined;

  private constructor(
    private readonly grantedProducer: BatchProducer,
    private readonly trackPath: string,
    private readonly createProducer: (directory: string) => Promise<BatchProducer>,
    private readonly consentManager: TrackingConsentManager
  ) {
    this.migration = new BatchMigration(trackPath);
    if (consentManager.get() === 'pending') {
      this.pendingStore = new PendingBatchStore(trackPath, createProducer);
    }
    this.subscription = consentManager.subscribe((change) => this.onConsentChange(change));
  }

  static async create(
    trackPath: string,
    createProducer: (directory: string) => Promise<BatchProducer>,
    consentManager: TrackingConsentManager
  ): Promise<ConsentAwareBatchRouter> {
    const grantedProducer = await createProducer(trackPath);
    return new ConsentAwareBatchRouter(grantedProducer, trackPath, createProducer, consentManager);
  }

  /** Selects the store now, so asynchronous creation cannot assign an event to a later consent period. */
  post(event: ServerEvent): void {
    const consent = ('storageConsent' in event ? event.storageConsent : undefined) ?? this.consentManager.get();
    if (consent === 'granted') {
      this.grantedProducer.post(event);
    } else if (this.pendingStore) {
      this.pendingStore.post(event);
    }
  }

  private onConsentChange(change: TrackingConsentChange): void {
    const previousStore = this.pendingStore;
    this.pendingStore =
      change.current === 'pending' ? new PendingBatchStore(this.trackPath, this.createProducer) : undefined;
    if (previousStore) {
      if (change.current === 'granted') {
        this.migration.authorize(previousStore);
      } else {
        this.migration.discard(previousStore);
      }
    }
  }

  /** Seals current batches and retries old migrations without blocking authorized uploads on their failures. */
  async flush(): Promise<void> {
    await this.pendingStore?.flush().catch(monitor((error) => display.error('Failed to flush pending batches', error)));
    await this.migration.flush();
    await this.grantedProducer.flush();
  }

  /** Releases the consent subscription. Previously accepted writes and migrations may still finish. */
  stop(): void {
    this.subscription.unsubscribe();
  }
}
