import {
  computeRawError,
  type ErrorWithCause,
  ErrorHandling,
  ErrorSource,
  isError,
  NonErrorPrefix,
  performDraw,
  sanitize,
} from '@datadog/browser-core';
import { clocksNow } from '@datadog/js-core/time';
import { combine, isIndexableObject } from '@datadog/js-core/util';
import type { Configuration } from '../../config';
import { EventFormat, EventKind, type EventManager } from '../../event';
import { display } from '../../tools/display';
import { isOneOf } from '../../tools/validation';

export const LOG_STATUSES = ['ok', 'debug', 'info', 'notice', 'warn', 'error', 'critical', 'alert', 'emerg'] as const;
/** Severity level of a log. */
export type LogStatus = (typeof LOG_STATUSES)[number];

/** Collects explicitly logged main-process messages independently of RUM session sampling. */
export class LogsCollection {
  constructor(
    private readonly eventManager: EventManager,
    private readonly config: Configuration
  ) {}

  log(message: string, context?: object, status: LogStatus = 'info', error?: unknown): void {
    if (!isOneOf(status, LOG_STATUSES)) {
      display.error('logger: status must be a supported log level. Log will not be sent.');
      return;
    }
    if (context != null && !isIndexableObject(context)) {
      display.error('logger: context must be an object. The context will be ignored.');
    }
    if (!performDraw(this.config.logsSampleRate)) return;

    const startClocks = clocksNow();
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

    const messageContext = sanitize(context);
    this.eventManager.notify({
      kind: EventKind.RAW,
      format: EventFormat.LOGS,
      startTime: startClocks.timeStamp,
      data: combine(
        {
          date: startClocks.timeStamp,
          message: sanitize(message) ?? '',
          status,
          origin: 'logger',
          ...(rawError
            ? {
                error: {
                  kind: rawError.type,
                  message: rawError.message,
                  stack: rawError.stack,
                  causes: rawError.causes?.map((cause) => ({
                    source: cause.source,
                    type: cause.type,
                    message: cause.message,
                    stack: cause.stack,
                  })),
                  handling: rawError.handling,
                  source_type: 'nodejs',
                },
              }
            : {}),
        },
        isIndexableObject(messageContext) ? messageContext : {}
      ),
    });
  }
}
