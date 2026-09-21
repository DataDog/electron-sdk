import { app } from 'electron';
import * as path from 'node:path';
import { timeStampNow } from '@datadog/js-core/time';
import { DISCARDED, SKIPPED } from '@datadog/js-core/assembly';
import type { FormatHooks } from '../../../assembly';
import { EventSource } from '../../../event';
import { DiskValueHistory } from '../../../tools/DiskValueHistory';
import { SESSION_TIME_OUT_DELAY } from '../../session';
import type { TrackingConsent } from '../../../config';
import type { TrackingConsentChange, TrackingConsentState } from '../../tracking-consent';

export const VIEW_HISTORY_FILE_NAME = '_dd_view_history';

/** Enriches events with the native view active at their context time, persisting only authorized history. */
export class ViewContext {
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
          return { view: { id, name: 'main process', url: 'electron://main-process' } }; // TODO(RUM-14657) improve name / url
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

  static async init(
    hooks: FormatHooks,
    expireDelay = SESSION_TIME_OUT_DELAY,
    trackingConsentState?: TrackingConsentState
  ): Promise<ViewContext> {
    const filePath = path.join(app.getPath('userData'), VIEW_HISTORY_FILE_NAME);
    const history = await DiskValueHistory.init<string>({ filePath, expireDelay });
    const context = new ViewContext(history, hooks);
    context.initializeTrackingConsent(trackingConsentState?.get());
    return context;
  }

  add(id: string): void {
    this.history.add(id, timeStampNow());
  }

  close(): void {
    this.history.closeActive(timeStampNow());
  }

  updateTrackingConsent(change: TrackingConsentChange, activeViewId?: string): void {
    if (change.previous === 'pending') {
      if (change.current === 'granted') {
        this.history.commitPausedChanges();
      } else {
        this.history.discardPausedChanges();
        this.history.pausePersistence();
      }
      return;
    }

    if (change.previous === 'not-granted') {
      this.history.discardPausedChanges();
      if (change.current === 'pending') {
        this.history.pausePersistence();
      }
      return;
    }

    const now = timeStampNow();
    this.history.closeActive(now);
    this.history.pausePersistence();
    if (change.current === 'pending' && activeViewId !== undefined) {
      this.history.add(activeViewId, now);
    }
  }

  private initializeTrackingConsent(consent: TrackingConsent | undefined): void {
    if (consent === 'pending' || consent === 'not-granted') {
      this.history.pausePersistence();
    }
  }
}
