import { app } from 'electron';
import * as path from 'node:path';
import { Observable, type Subscription } from '@datadog/browser-core';
import { DISCARDED, SKIPPED } from '@datadog/js-core/assembly';
import { timeStampNow, type TimeStamp } from '@datadog/js-core/time';
import type { FormatHooks } from '../../assembly';
import { DiskValueHistory } from '../../tools/DiskValueHistory';
import { TimeStampValueHistory } from '../../tools/TimeStampValueHistory';
import { SESSION_TIME_OUT_DELAY } from '../session';
import { monitor } from '../telemetry';

export const TRACKING_CONSENT_HISTORY_FILE_NAME = '_dd_tracking_consent_history';

type ConsentHistory = Pick<TimeStampValueHistory<TrackingConsent>, 'add' | 'closeActive' | 'find' | 'getEntries'>;

/**
 * Owns the consent state and its timestamped history, with synchronous change notifications.
 * When initialized for the SDK, the history is persisted, and assembly discards RUM events captured during a
 * refused period, including events recovered at a later launch, such as crashes.
 */
export class TrackingConsentManager {
  private readonly changes = new Observable<TrackingConsentChange>();

  constructor(
    initialConsent: TrackingConsent = 'granted',
    private readonly history: ConsentHistory = new TimeStampValueHistory<TrackingConsent>({ expireDelay: Infinity })
  ) {
    this.record(initialConsent, timeStampNow());
  }

  static async init(hooks: FormatHooks, initialConsent: TrackingConsent = 'granted'): Promise<TrackingConsentManager> {
    const history = await DiskValueHistory.init<TrackingConsent>({
      filePath: path.join(app.getPath('userData'), TRACKING_CONSENT_HISTORY_FILE_NAME),
      expireDelay: SESSION_TIME_OUT_DELAY,
    });
    const now = timeStampNow();
    // A new process cannot grant the previous one's undecided period, whose pending batches it deletes.
    if (history.find(now) === 'pending') {
      history.closeAndAdd('not-granted', now);
    }
    const manager = new TrackingConsentManager(initialConsent, history);

    hooks.registerRum(({ startTime }) => {
      // Events of an undecided pending period are held by the batch storage until its decision.
      const consent = manager.getDecisionAt(startTime);
      return consent === 'granted' || consent === 'pending' ? SKIPPED : DISCARDED;
    });

    return manager;
  }

  /** Consent applying to data captured at a time: a past pending period takes the state that ended it. */
  private getDecisionAt(time: TimeStamp): TrackingConsent | undefined {
    const entries = this.history.getEntries();
    const index = entries.findIndex((entry) => entry.startTime <= time && time < entry.endTime);
    if (index === -1) {
      return undefined;
    }
    const { value } = entries[index];
    return value === 'pending' && index > 0 ? entries[index - 1].value : value;
  }

  get(): TrackingConsent {
    return this.history.find(timeStampNow())!;
  }

  /** Original consent at a time, or undefined when no history covers it. */
  getAt(time: TimeStamp): TrackingConsent | undefined {
    return this.history.find(time);
  }

  /** Update the state and notify subscribers. Repeating the active state has no effect. */
  update(consent: TrackingConsent): void {
    const previous = this.get();
    if (consent === previous) {
      return;
    }

    const time = timeStampNow();
    this.record(consent, time);
    this.changes.notify({ previous, current: consent, time });
  }

  private record(consent: TrackingConsent, time: TimeStamp): void {
    this.history.closeActive(time);
    this.history.add(consent, time);
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
