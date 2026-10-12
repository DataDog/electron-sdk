import { app } from 'electron';
import * as path from 'node:path';
import { Observable, type Subscription } from '@datadog/browser-core';
import { DISCARDED, SKIPPED } from '@datadog/js-core/assembly';
import { timeStampNow, type TimeStamp } from '@datadog/js-core/time';
import type { FormatHooks } from '../../assembly';
import { DiskValueHistory } from '../../tools/DiskValueHistory';
import { SESSION_TIME_OUT_DELAY } from '../session';
import { monitor } from '../telemetry';

export const TRACKING_CONSENT_HISTORY_FILE_NAME = '_dd_tracking_consent_history';

/**
 * Owns the consent state and its persisted, timestamped history, with synchronous change notifications.
 * Assembly discards RUM events captured during a refused period, including events recovered at a later launch,
 * such as crashes.
 */
export class TrackingConsentManager {
  private readonly changes = new Observable<TrackingConsentChange>();

  private constructor(
    hooks: FormatHooks,
    private readonly history: DiskValueHistory<TrackingConsent>,
    initialConsent: TrackingConsent
  ) {
    const now = timeStampNow();
    // A new process cannot grant the previous one's undecided period, whose pending batches it deletes.
    if (this.get() === 'pending') {
      this.updateHistory('not-granted', now);
    }
    this.updateHistory(initialConsent, now);

    hooks.registerRum(({ startTime }) => {
      // Events of an undecided pending period are held by the batch storage until its decision.
      const consent = this.history.find(startTime);
      return consent === 'granted' || consent === 'pending' ? SKIPPED : DISCARDED;
    });
  }

  static async init(hooks: FormatHooks, initialConsent: TrackingConsent = 'granted'): Promise<TrackingConsentManager> {
    const history = await DiskValueHistory.init<TrackingConsent>({
      filePath: path.join(app.getPath('userData'), TRACKING_CONSENT_HISTORY_FILE_NAME),
      expireDelay: SESSION_TIME_OUT_DELAY,
    });
    const manager = new TrackingConsentManager(hooks, history, initialConsent);
    // Until this write lands, a crash of this launch would be judged by the previous launch's consent.
    await history.flush();
    return manager;
  }

  get(): TrackingConsent {
    return this.history.find(timeStampNow())!;
  }

  /** Update the state and notify subscribers. Repeating the active state has no effect. */
  update(consent: TrackingConsent): void {
    const previous = this.get();
    if (consent === previous) {
      return;
    }

    const time = timeStampNow();
    this.updateHistory(consent, time);
    this.changes.notify({ previous, current: consent, time });
  }

  /** A decision covers the whole pending period it ends, like the batches held during that period. */
  private updateHistory(consent: TrackingConsent, time: TimeStamp): void {
    const [active] = this.history.getEntries();
    this.history.closeAndAdd(consent, active?.value === 'pending' ? active.startTime : time);
  }

  /** Subscribe to future changes. A failing observer must not interrupt other consumers. */
  subscribe(callback: (change: TrackingConsentChange) => void): Subscription {
    return this.changes.subscribe(monitor(callback));
  }
}

export type TrackingConsent = 'granted' | 'pending' | 'not-granted';

export interface TrackingConsentChange {
  readonly previous: TrackingConsent;
  readonly current: TrackingConsent;
  readonly time: TimeStamp;
}
