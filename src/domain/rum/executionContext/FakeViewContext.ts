import { app } from 'electron';
import * as path from 'node:path';
import type { TimeStamp } from '@datadog/js-core/time';
import { DISCARDED, SKIPPED } from '@datadog/js-core/assembly';
import type { FormatHooks } from '../../../assembly';
import { EventSource } from '../../../event';
import { DiskValueHistory } from '../../../tools/DiskValueHistory';
import { SESSION_TIME_OUT_DELAY } from '../../session';

export const VIEW_HISTORY_FILE_NAME = '_dd_view_history';

/**
 * Attaches the fake main-process view to every event, resolved by event timestamp from a disk-persisted history:
 * main-process RUM events as their `view`, renderer RUM events as their `container.view`, and main-process
 * telemetry, logs and spans as their view id.
 *
 * Transitional: it exists only while events still require a `view.id`, and goes away with fake views. See "Fake
 * views" in docs/ARCHITECTURE.md.
 */
export class FakeViewContext {
  private readonly history: DiskValueHistory<string>;

  private constructor(history: DiskValueHistory<string>, hooks: FormatHooks) {
    this.history = history;

    hooks.registerRum(({ source, startTime }) => {
      const id = this.history.find(startTime);
      if (id === undefined) return DISCARDED;
      switch (source) {
        case EventSource.RENDERER:
          return { container: { view: { id } } };
        case EventSource.MAIN:
          // Same id as the view RUM document MainProcessContext emits.
          return { view: { id, url: 'electron://fake', is_fake: true } };
      }
    });

    hooks.registerTelemetry((params) => {
      // A renderer telemetry event already carries the view its browser SDK reported, which is the view
      // its RUM events are attached to. The telemetry schema has no `container` to hold the main-process
      // view alongside it (unlike RUM events above), so the renderer's view is kept as it is.
      if (params.source === EventSource.RENDERER) return SKIPPED;
      const id = this.history.find(params.startTime);
      if (id === undefined) return SKIPPED;
      return { view: { id } };
    });

    hooks.registerLogs((params) => {
      // A renderer log already carries the view its browser SDK reported, which is the view its RUM
      // events are attached to. Logs have no `container` to hold the main-process view alongside it,
      // so the renderer's view is kept as it is — same reasoning as telemetry above.
      if (params.source === EventSource.RENDERER) return SKIPPED;
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

  static async init(hooks: FormatHooks, expireDelay = SESSION_TIME_OUT_DELAY): Promise<FakeViewContext> {
    const filePath = path.join(app.getPath('userData'), VIEW_HISTORY_FILE_NAME);
    const history = await DiskValueHistory.init<string>({ filePath, expireDelay });
    return new FakeViewContext(history, hooks);
  }

  /** Registers the view at its event timestamp, even if registration happens later. */
  add(id: string, atTime: TimeStamp): void {
    this.history.add(id, atTime);
  }

  /** Closes the active view at the supplied transition time. */
  close(atTime: TimeStamp): void {
    this.history.closeActive(atTime);
  }
}
