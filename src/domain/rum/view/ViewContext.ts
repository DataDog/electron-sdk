import { app } from 'electron';
import * as path from 'node:path';
import { timeStampNow, type TimeStamp } from '@datadog/js-core/time';
import { DISCARDED, SKIPPED } from '@datadog/js-core/assembly';
import type { FormatHooks } from '../../../assembly';
import { EventSource } from '../../../event';
import { DiskValueHistory } from '../../../tools/DiskValueHistory';
import { SESSION_TIME_OUT_DELAY } from '../../session';

export const VIEW_HISTORY_FILE_NAME = '_dd_view_history';

export class ViewContext {
  private readonly history: DiskValueHistory<string>;

  private constructor(history: DiskValueHistory<string>, hooks: FormatHooks, isExecutionContextEnabled: boolean) {
    this.history = history;

    hooks.registerRum(({ source, startTime }) => {
      const id = this.history.find(startTime);
      if (id === undefined) return DISCARDED;
      switch (source) {
        case EventSource.RENDERER:
          return { container: { view: { id } } };
        case EventSource.MAIN:
          return isExecutionContextEnabled
            ? { view: { id, url: 'electron://fake', is_fake: true } }
            : { view: { id, name: 'main process', url: 'electron://main-process' } }; // TODO(RUM-14657) improve name / url
      }
    });

    hooks.registerTelemetry((params) => {
      const id = this.history.find(params.startTime);
      if (id === undefined) return SKIPPED;
      return { view: { id } };
    });

    hooks.registerSpan((params) => {
      const id = this.history.find(params.startTime);
      if (id === undefined) return DISCARDED;
      return { meta: { '_dd.view.id': id } };
    });
  }

  static async init(
    hooks: FormatHooks,
    expireDelay = SESSION_TIME_OUT_DELAY,
    options?: { isExecutionContextEnabled?: boolean }
  ): Promise<ViewContext> {
    const filePath = path.join(app.getPath('userData'), VIEW_HISTORY_FILE_NAME);
    const history = await DiskValueHistory.init<string>({ filePath, expireDelay });
    return new ViewContext(history, hooks, options?.isExecutionContextEnabled ?? false);
  }

  add(id: string, atTime: TimeStamp = timeStampNow()): void {
    this.history.add(id, atTime);
  }

  close(atTime: TimeStamp = timeStampNow()): void {
    this.history.closeActive(atTime);
  }
}
