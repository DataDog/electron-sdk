import { DISCARDED, SKIPPED, timeStampNow } from '@datadog/browser-core';
import type { FormatHooks } from '../../../assembly';
import { TimeStampValueHistory } from '../../../tools/TimeStampValueHistory';
import { SESSION_TIME_OUT_DELAY } from '../../session';

export class ViewContext {
  private readonly history;

  constructor(hooks: FormatHooks, expireDelay = SESSION_TIME_OUT_DELAY) {
    this.history = new TimeStampValueHistory<string>({ expireDelay });

    hooks.registerRum((params) => {
      const id = this.history.find(params.startTime);
      if (id === undefined) return DISCARDED;
      return { view: { id, name: 'main process', url: 'electron://main-process' } }; // TODO(RUM-14657) improve name / url
    });

    hooks.registerTelemetry((params) => {
      const id = this.history.find(params.startTime);
      if (id === undefined) return SKIPPED;
      return { view: { id } };
    });
  }

  add(id: string): void {
    this.history.add(id, timeStampNow());
  }

  close(): void {
    this.history.closeActive(timeStampNow());
  }
}
