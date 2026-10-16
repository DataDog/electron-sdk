import {
  computeRawError,
  type ErrorWithCause,
  ErrorHandling,
  ErrorSource,
  isError,
  NonErrorPrefix,
  performDraw,
} from '@datadog/browser-core';
import { clocksNow, ONE_MINUTE } from '@datadog/js-core/time';
import { isIndexableObject } from '@datadog/js-core/util';
import type { Configuration } from '../../config';
import { EventFormat, EventKind, type EventManager } from '../../event';
import { display } from '../../tools/display';
import { isOneOf } from '../../tools/validation';

export const LOG_STATUSES = ['ok', 'debug', 'info', 'notice', 'warn', 'error', 'critical', 'alert', 'emerg'] as const;
export type LogStatus = (typeof LOG_STATUSES)[number];

// Match Browser Logs' per-status budget. Timestamp windows avoid timers that keep Node alive.
const LOGS_PER_MINUTE = 3_000;

/** Collects explicitly logged main-process messages independently of RUM session sampling. */
export class LogsCollection {
  private readonly rateWindows = new Map<LogStatus, { start: number; count: number }>();

  constructor(
    private readonly eventManager: EventManager,
    private readonly config: Configuration
  ) {}

  log(message: string, context?: object, status: LogStatus = 'info', error?: unknown): void {
    if (!isOneOf(status, LOG_STATUSES)) {
      display.error('logger: status must be a supported log level. Log will not be sent.');
      return;
    }
    if (!performDraw(this.config.logsSampleRate)) return;

    const startClocks = clocksNow();
    if (this.isRateLimited(status, startClocks.relative)) return;
    const rawError =
      error == null
        ? undefined
        : computeRawError({
            originalError: error,
            nonErrorPrefix: NonErrorPrefix.PROVIDED,
            source: ErrorSource.LOGGER,
            handling: ErrorHandling.HANDLED,
            startClocks,
          });
    // computeRawError normalizes stacks for browsers. Electron's Node parser needs native stacks,
    // including those of wrapped causes; reuse its metadata extraction without changing the format.
    if (rawError && isError(error)) {
      rawError.stack = error.stack;
      let cause = (error as ErrorWithCause).cause;
      for (const rawCause of rawError.causes ?? []) {
        if (isError(cause)) {
          rawCause.stack = cause.stack;
          cause = (cause as ErrorWithCause).cause;
        }
      }
    }

    this.eventManager.notify({
      kind: EventKind.RAW,
      format: EventFormat.LOGS,
      startTime: startClocks.timeStamp,
      context: {
        ...(isIndexableObject(rawError?.context) ? rawError.context : {}),
        ...(isIndexableObject(context) ? context : {}),
      },
      data: {
        date: startClocks.timeStamp,
        message,
        status,
        origin: 'logger',
        ...(rawError
          ? {
              error: {
                kind: rawError.type,
                message: rawError.message,
                stack: rawError.stack,
                causes: rawError.causes,
                fingerprint: rawError.fingerprint,
                handling: rawError.handling,
                source_type: 'nodejs',
              },
            }
          : {}),
      },
    });
  }

  private isRateLimited(status: LogStatus, now: number): boolean {
    let window = this.rateWindows.get(status);
    if (!window || now - window.start >= ONE_MINUTE) {
      window = { start: now, count: 0 };
      this.rateWindows.set(status, window);
    }
    window.count++;
    if (window.count === LOGS_PER_MINUTE + 1) {
      display.warn(
        `logger: reached the limit of ${LOGS_PER_MINUTE} ${status} logs per minute. Further logs will be dropped until the next window.`
      );
    }
    return window.count > LOGS_PER_MINUTE;
  }
}
