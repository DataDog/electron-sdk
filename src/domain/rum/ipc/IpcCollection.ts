import { toServerDuration } from '@datadog/js-core/time';
import { generateUUID } from '@datadog/js-core/util';
import * as DiagnosticsChannel from 'node:diagnostics_channel';
import { IPC_HANDLE_CHANNEL, type IpcHandlerCall } from '../../../common';
import { EventFormat, EventKind, EventManager } from '../../../event';
import { monitor } from '../../telemetry';
import type { RawRumMessageResource } from '../types';

/**
 * Reports the IPC handler calls published by the instrumentation as RUM resources of type `message`, one per call.
 * Only the handling side is reported, so each resource gets a message id of its own.
 */
export class IpcCollection {
  private readonly diagnosticsChannel = DiagnosticsChannel.channel(IPC_HANDLE_CHANNEL);
  private readonly onHandlerCall = monitor((call: unknown) => this.emit(call as IpcHandlerCall));

  constructor(private readonly eventManager: EventManager) {
    this.diagnosticsChannel.subscribe(this.onHandlerCall);
  }

  stop(): void {
    this.diagnosticsChannel.unsubscribe(this.onHandlerCall);
  }

  private emit({ channel, startTime, duration, isError }: IpcHandlerCall): void {
    const data: RawRumMessageResource = {
      type: 'resource',
      date: startTime,
      resource: {
        id: generateUUID(),
        duration: toServerDuration(duration),
        type: 'message',
        url: channel,
        message: { id: generateUUID(), role: 'destination', api: 'handle', is_error: isError },
      },
    };

    this.eventManager.notify({ kind: EventKind.RAW, format: EventFormat.RUM, data, startTime });
  }
}
