import { app } from 'electron';
import * as path from 'node:path';
import { DISCARDED, SKIPPED, timeStampNow } from '@datadog/browser-core';
import type { FormatHooks } from '../../../assembly';
import { DiskValueHistory } from '../../../tools/DiskValueHistory';
import { SESSION_TIME_OUT_DELAY } from '../../session';

export const VIEW_HISTORY_FILE_NAME = '_dd_view_history';

export class ViewContext {
  private readonly history: DiskValueHistory<string>;

  private constructor(history: DiskValueHistory<string>, hooks: FormatHooks) {
    this.history = history;

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

  static async init(hooks: FormatHooks, expireDelay = SESSION_TIME_OUT_DELAY): Promise<ViewContext> {
    const filePath = path.join(app.getPath('userData'), VIEW_HISTORY_FILE_NAME);
    const history = await DiskValueHistory.init<string>({ filePath, expireDelay });
    return new ViewContext(history, hooks);
  }

  add(id: string): void {
    this.history.add(id, timeStampNow());
  }

  close(): void {
    this.history.closeActive(timeStampNow());
  }
}
