import { generateUUID } from '@datadog/browser-core';
import { EventFormat, EventKind, EventManager, EventSource } from '../../event';
import type { RawRumError } from './rawRumData.types';
import { monitor } from '../telemetry';

/**
 * Collect RUM error events for:
 * - uncaught exception
 * - unhandled rejection
 */
export class ErrorCollection {
  private readonly errorListener: (error: unknown) => void;

  constructor(private readonly eventManager: EventManager) {
    this.errorListener = monitor((error: unknown) => this.emitError(error));
    process.on('uncaughtException', this.errorListener);
    process.on('unhandledRejection', this.errorListener);
  }

  stop(): void {
    process.off('uncaughtException', this.errorListener);
    process.off('unhandledRejection', this.errorListener);
  }

  private emitError(error: unknown): void {
    const { message, stack, kind } = formatError(error);

    const errorEvent: RawRumError = {
      type: 'error',
      error: {
        id: generateUUID(),
        message,
        source: 'source',
        handling: 'unhandled',
        stack,
        type: kind,
      },
    };

    this.eventManager.notify({
      kind: EventKind.RAW,
      source: EventSource.MAIN,
      format: EventFormat.RUM,
      data: errorEvent,
    });
  }
}

function formatError(error: unknown): { message: string; stack?: string; kind?: string } {
  if (error instanceof Error) {
    return { message: error.message, stack: error.stack, kind: error.name };
  }
  return { message: `Uncaught ${JSON.stringify(error)}` };
}
