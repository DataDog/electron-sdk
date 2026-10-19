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
 * Its format hooks discard RUM events and spans that started in a refused period or in no known period, including
 * events recovered at a later launch, such as crashes.
 */
export class TrackingConsentManager {
  private readonly changes = new Observable<TrackingConsentChange>();

  private constructor(
    hooks: FormatHooks,
    private readonly history: DiskValueHistory<TrackingConsent>,
    initialConsent: TrackingConsent
  ) {
    // A new process cannot grant the previous one's undecided period, whose pending batches it deletes.
    if (this.get() === 'pending') {
      this.updateHistory('not-granted');
    }
    this.updateHistory(initialConsent);

    const checkConsent = ({ startTime }: { startTime: TimeStamp }) =>
      this.allowsDataCapturedAt(startTime) ? SKIPPED : DISCARDED;
    hooks.registerRum(checkConsent);
    hooks.registerSpan(checkConsent);
  }

  static async init(hooks: FormatHooks, initialConsent: TrackingConsent): Promise<TrackingConsentManager> {
    const history = await DiskValueHistory.init<TrackingConsent>({
      filePath: path.join(app.getPath('userData'), TRACKING_CONSENT_HISTORY_FILE_NAME),
      expireDelay: SESSION_TIME_OUT_DELAY,
    });
    return new TrackingConsentManager(hooks, history, initialConsent);
  }

  get(): TrackingConsent {
    return this.history.find(timeStampNow())!;
  }

  /**
   * Whether data captured at a time may be written to batch storage: the time falls in a granted period, or in the
   * undecided pending period, whose data is held by batch storage until the decision.
   */
  allowsDataCapturedAt(time: TimeStamp): boolean {
    const consent = this.history.find(time);
    return consent === 'granted' || consent === 'pending';
  }

  /** Update the state and notify subscribers. Repeating the active state has no effect. */
  update(consent: TrackingConsent): void {
    const previous = this.get();
    if (consent === previous) {
      return;
    }

    this.updateHistory(consent);
    this.changes.notify({ previous, current: consent, time: timeStampNow() });
  }

  private updateHistory(consent: TrackingConsent): void {
    if (this.get() === 'pending') {
      // A decision covers the whole pending period it ends, like the batches held during that period.
      this.history.updateActive(consent);
    } else {
      this.history.closeAndAdd(consent, timeStampNow());
    }
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
