import { Observable, type Subscription } from '@datadog/browser-core';
import { timeStampNow, type TimeStamp } from '@datadog/js-core/time';
import { TimeStampValueHistory, type TimeStampHistoryEntry } from '../../tools/TimeStampValueHistory';
import { monitor } from '../telemetry';
import { ConsentHistoryStorage } from './ConsentHistoryStorage';

/**
 * Owns consent and its history, with synchronous change notifications.
 * Persisted instances retain the previous launch for crash authorization, independently of current consent.
 */
export class TrackingConsentManager {
  private readonly history = new TimeStampValueHistory<TrackingConsent>({ expireDelay: Infinity });
  private readonly changes = new Observable<TrackingConsentChange>();
  private readonly launchTime = timeStampNow();
  private previousHistory: readonly TimeStampHistoryEntry<TrackingConsent>[] = [];
  private storage?: ConsentHistoryStorage;

  constructor(initialConsent: TrackingConsent = 'granted') {
    this.history.add(initialConsent, this.launchTime);
  }

  static async start(basePath: string, initialConsent: TrackingConsent = 'granted'): Promise<TrackingConsentManager> {
    const manager = new TrackingConsentManager(initialConsent);
    manager.storage = new ConsentHistoryStorage(basePath);
    manager.previousHistory = await manager.storage.load(manager.launchTime);
    // Only this launch is saved: its decisions must not authorize unresolved data from an earlier launch.
    manager.storage.save(manager.history.getEntries());
    await manager.flush();
    return manager;
  }

  get(): TrackingConsent {
    return this.history.find(timeStampNow())!;
  }

  /** Original consent during this launch, or undefined before this manager was created. */
  getAt(time: TimeStamp): TrackingConsent | undefined {
    return this.history.find(time);
  }

  /** Includes recovered consent; pending is authorized only by its next decision within the same launch. */
  isAuthorizedAt(time: TimeStamp): boolean {
    const entries = this.entriesAt(time);
    const index = entries.findIndex((entry) => entry.startTime <= time && time < entry.endTime);
    if (index === -1) return false;
    const consent = entries[index].value;
    return consent === 'granted' || (consent === 'pending' && index > 0 && entries[index - 1].value === 'granted');
  }

  private entriesAt(time: TimeStamp): readonly TimeStampHistoryEntry<TrackingConsent>[] {
    return time < this.launchTime ? this.previousHistory : this.history.getEntries();
  }

  /** Update the state and notify subscribers. Repeating the active state has no effect. */
  update(consent: TrackingConsent): void {
    const previous = this.get();
    if (consent === previous) {
      return;
    }

    const time = timeStampNow();
    this.history.closeActive(time);
    this.history.add(consent, time);
    this.storage?.save(this.history.getEntries());
    this.changes.notify({ previous, current: consent, time });
  }

  /** Subscribe to future changes. A failing observer must not interrupt other consumers. */
  subscribe(callback: (change: TrackingConsentChange) => void): Subscription {
    return this.changes.subscribe(monitor(callback));
  }

  /** Wait for the writes already queued by this manager. */
  async flush(): Promise<void> {
    await this.storage?.flush();
  }
}

export type TrackingConsent = 'granted' | 'pending' | 'not-granted';

export interface TrackingConsentChange {
  readonly previous: TrackingConsent;
  readonly current: TrackingConsent;
  readonly time: TimeStamp;
}
