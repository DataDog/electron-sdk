import * as path from 'node:path';
import type { Subscription } from '@datadog/browser-core';
import { timeStampNow } from '@datadog/js-core/time';
import { DiskStorage } from '../../tools/DiskStorage';
import type { TimeStampHistoryEntry } from '../../tools/TimeStampValueHistory';
import { monitor } from '../telemetry';
import type { TrackingConsentChange, TrackingConsentManager } from './TrackingConsentManager';
import { TrackingConsentHistory } from './TrackingConsentHistory';

/**
 * Owns context histories and their shared consent subscription.
 * Subscribe before session and collector callbacks so values they write use the new consent policy.
 */
export class ContextHistoryFactory {
  private readonly startTime = timeStampNow();
  private readonly subscription: Subscription;
  private readonly updateHistories: ((change: TrackingConsentChange) => void)[] = [];

  constructor(
    private readonly consentManager: TrackingConsentManager,
    private readonly basePath: string
  ) {
    this.subscription = consentManager.subscribe((change) => {
      for (const update of this.updateHistories) update(change);
    });
  }

  async create<T>(fileName: string, expireDelay: number): Promise<TrackingConsentHistory<T>> {
    const storage = new DiskStorage<readonly TimeStampHistoryEntry<T>[]>(path.join(this.basePath, fileName));
    const entries = await storage.load();
    const history = new TrackingConsentHistory(storage, {
      entries,
      expireDelay,
      consent: this.consentManager.get(),
      startTime: this.startTime,
    });
    // A customer value that fails serialization must not block the other histories.
    this.updateHistories.push(monitor((change) => history.updateConsent(change)));
    return history;
  }

  stop(): void {
    this.subscription.unsubscribe();
    this.updateHistories.length = 0;
  }
}
