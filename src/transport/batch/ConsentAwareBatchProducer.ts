import type { Subscription } from '@datadog/browser-core';
import type { TrackingConsentChange, TrackingConsentManager } from '../../domain/tracking-consent';
import { monitor } from '../../domain/telemetry';
import type { ServerEvent } from '../../event';
import { display } from '../../tools/display';
import type { BatchProducer } from './BatchProducer';
import { authorizePendingBatches, recoverAuthorizedPendingBatches } from './trackingConsentStorage';

/**
 * Routes writes into authorized or pending batches and orders consent decisions with disk writes.
 * A failed cleanup blocks reuse of pending storage; a failed authorization retains ownership of
 * its files until they can be moved safely. Already authorized batches remain uploadable.
 */
export class ConsentAwareBatchProducer {
  private readonly subscription: Subscription;
  private lastTransition: Promise<void> = Promise.resolve();
  private readonly pendingStore: PendingStore = { readiness: Promise.resolve(true) };

  constructor(
    private readonly authorizedProducer: BatchProducer,
    private readonly pendingProducer: BatchProducer,
    private readonly authorizedPath: string,
    private readonly pendingPath: string,
    private readonly consentManager: TrackingConsentManager
  ) {
    this.subscription = consentManager.subscribe((change) => this.onConsentChange(change));
  }

  /** Captures consent when the event is submitted, before any asynchronous disk work. */
  post(event: ServerEvent): void {
    const consent = this.consentManager.get();
    if (consent === 'granted') {
      this.authorizedProducer.post(event);
    } else if (consent === 'pending') {
      this.pendingProducer.post(event, this.pendingStore.readiness);
    }
  }

  /** Seals batches and retries unfinished authorizations or deletions before an upload cycle. */
  async flush(): Promise<void> {
    await this.lastTransition;
    const readiness = this.pendingStore.readiness;
    if (!(await readiness) && this.pendingStore.readiness === readiness) {
      const recovery = this.preparePendingStore(this.takeAuthorization());
      this.pendingStore.readiness = toReadiness(recovery);
      await recovery;
    }

    const retry = this.pendingStore.authorizationRetry;
    const authorization = this.pendingStore.authorization;
    if (retry) {
      const recovery = this.preparePendingStore(retry);
      this.pendingStore.readiness = toReadiness(recovery);
      await recovery;
    } else if (authorization) {
      await this.authorizePendingInterval(authorization);
    }
    await this.pendingProducer.runAfterFlush(() => recoverAuthorizedPendingBatches(this.authorizedPath));
    await this.authorizedProducer.flush();
  }

  /** Releases the subscription owned by this storage coordinator. */
  stop(): void {
    this.subscription.unsubscribe();
  }

  private onConsentChange(change: TrackingConsentChange): void {
    let operation: Promise<void>;
    if (change.previous === 'pending' && change.current === 'granted') {
      const readiness = this.pendingStore.readiness;
      this.pendingStore.authorization = readiness;
      operation = this.authorizePendingInterval(readiness);
    } else if (change.current === 'pending' || change.current === 'not-granted') {
      operation = this.preparePendingStore(this.takeAuthorization());
      this.pendingStore.readiness = toReadiness(operation);
    } else {
      return;
    }

    // Reserve the operation on the producer immediately, before later writes or transitions.
    // Keep its completion for flush(), while reporting failures without rejecting the next write.
    this.lastTransition = operation.catch(
      monitor((error) => display.error('Failed to update consent batch storage', error))
    );
  }

  private async authorizePendingStore(readiness: Promise<boolean>): Promise<void> {
    if (await readiness) {
      await authorizePendingBatches(this.pendingPath, this.authorizedPath);
      await this.authorizedProducer.flush();
    }
  }

  private async authorizePendingInterval(readiness: Promise<boolean>): Promise<void> {
    try {
      await this.pendingProducer.runAfterFlush(() => this.authorizePendingStore(readiness));
      this.completeAuthorization(readiness);
    } catch (error) {
      this.pendingStore.authorizationRetry ??= readiness;
      throw error;
    }
  }

  private preparePendingStore(readiness?: Promise<boolean>): Promise<void> {
    return this.pendingProducer.clearAfterFlush(async () => {
      // An earlier queued grant can fail after this operation was reserved. Recover it before
      // deleting or reusing its files, even if a later pending interval could not be prepared.
      const authorization = this.pendingStore.authorizationRetry ?? readiness;
      if (!authorization) {
        return;
      }
      try {
        await this.authorizePendingStore(authorization);
      } catch (error) {
        this.pendingStore.authorizationRetry ??= authorization;
        throw error;
      }
      this.completeAuthorization(authorization);
    });
  }

  private takeAuthorization(): Promise<boolean> | undefined {
    const readiness = this.pendingStore.authorizationRetry ?? this.pendingStore.authorization;
    if (readiness === this.pendingStore.authorization) {
      this.pendingStore.authorization = undefined;
    }
    return readiness;
  }

  private completeAuthorization(readiness: Promise<boolean>): void {
    if (this.pendingStore.authorization === readiness) {
      this.pendingStore.authorization = undefined;
    }
    if (this.pendingStore.authorizationRetry === readiness) {
      this.pendingStore.authorizationRetry = undefined;
    }
  }
}

interface PendingStore {
  /** False means old files could not be removed; writes from this interval must be discarded. */
  readiness: Promise<boolean>;
  /** Readiness of the interval whose grant has been queued. */
  authorization?: Promise<boolean>;
  /** A granted interval whose files must be recovered before the directory can be cleared. */
  authorizationRetry?: Promise<boolean>;
}

async function toReadiness(operation: Promise<void>): Promise<boolean> {
  try {
    await operation;
    return true;
  } catch {
    return false;
  }
}
