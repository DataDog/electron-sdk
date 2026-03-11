import { DISCARDED, SKIPPED, timeStampNow } from '@datadog/browser-core';
import type { FormatHooks } from '../../assembly';
import { TimeStampValueHistory } from '../../tools/TimeStampValueHistory';
import { SESSION_TIME_OUT_DELAY } from './session.constants';

export class SessionContext {
  private readonly history;

  constructor(hooks: FormatHooks, expireDelay = SESSION_TIME_OUT_DELAY) {
    this.history = new TimeStampValueHistory<string>({ expireDelay });

    hooks.registerRum((params) => {
      const id = this.history.find(params.startTime);
      if (id === undefined) return DISCARDED;
      return { session: { id } };
    });

    hooks.registerTelemetry((params) => {
      const id = this.history.find(params.startTime);
      if (id === undefined) return SKIPPED;
      return { session: { id } };
    });
  }

  add(sessionId: string): void {
    this.history.add(sessionId, timeStampNow());
  }

  close(): void {
    this.history.closeActive(timeStampNow());
  }
}
