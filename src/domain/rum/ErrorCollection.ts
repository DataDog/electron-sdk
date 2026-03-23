import { Context, generateUUID, jsonStringify, type TimeStamp, timeStampNow } from '@datadog/browser-core';
import { EventFormat, EventKind, EventManager, EventSource } from '../../event';
import type { RawRumError } from './rawRumData.types';
import { monitor } from '../telemetry';

export interface ErrorOptions {
  /**
   * Custom context for the added error.
   */
  context?: Context;

  /**
   * Timestamp for the added error.
   */
  startTime?: number;
}

/**
 * Collect RUM error events for:
 * - uncaught exception
 * - unhandled rejection
 * - manually added error
 */
export class ErrorCollection {
  private readonly errorListener: (error: unknown) => void;

  constructor(private readonly eventManager: EventManager) {
    this.errorListener = monitor((error: unknown) =>
      this.emitError(error, {
        handling: 'unhandled',
        source: 'source',
        nonErrorPrefix: 'Uncaught',
      })
    );
    process.on('uncaughtException', this.errorListener);
    process.on('unhandledRejection', this.errorListener);
  }

  getApi() {
    return {
      addError: (error: unknown, options?: ErrorOptions) =>
        this.emitError(error, {
          handling: 'handled',
          source: 'custom',
          nonErrorPrefix: 'Provided',
          ...options,
        }),
    };
  }

  stop(): void {
    process.off('uncaughtException', this.errorListener);
    process.off('unhandledRejection', this.errorListener);
  }

  private emitError(
    error: unknown,
    options: ErrorOptions & {
      handling: RawRumError['error']['handling'];
      source: RawRumError['error']['source'];
      nonErrorPrefix: 'Uncaught' | 'Provided';
    }
  ): void {
    const { message, stack, kind } = formatError(error, options.nonErrorPrefix);
    const startTime = (options.startTime as TimeStamp) ?? timeStampNow();

    const errorEvent: RawRumError = {
      type: 'error',
      date: startTime,
      context: options.context ?? {},
      error: {
        id: generateUUID(),
        message,
        source: options.source,
        handling: options.handling,
        stack,
        type: kind,
      },
    };

    this.eventManager.notify({
      kind: EventKind.RAW,
      source: EventSource.MAIN,
      format: EventFormat.RUM,
      data: errorEvent,
      startTime,
    });
  }
}

function formatError(error: unknown, nonErrorPrefix: string): { message: string; stack?: string; kind?: string } {
  if (error instanceof Error) {
    return { message: error.message, stack: error.stack, kind: error.name };
  }
  return { message: `${nonErrorPrefix} ${jsonStringify(error)}` };
}
