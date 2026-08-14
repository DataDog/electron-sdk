import { type Duration, type TimeStamp, toServerDuration } from '@datadog/js-core/time';
import { generateUUID } from '@datadog/browser-core';
import { EventFormat, EventKind, type EventManager } from '../../event';
import { setIpcEventHandler, type IpcChannelMessage } from '../../instrument/ipc';
import { monitor } from '../telemetry';
import type { RawRumResource } from '../rum';

/**
 * Registers itself as ipc.ts's IPC event handler, and converts each invocation into a RUM resource
 * event. `registerHandler` defaults to the real `setIpcEventHandler`, and is injectable so tests can
 * supply a fake without going through ipc.ts's module-level setter.
 *
 * `resource.type` stays `'native'` — the rum-events-format schema (auto-generated, does not accept an
 * `'ipc'` literal) has no dedicated IPC resource type. IPC identity is carried entirely by
 * `context.ipc.{role,id,method}`, not a top-level `ipc` field, for parity with the renderer side
 * (Task 4/9), which can only attach custom data via `startResource`/`stopResource`'s `context` option.
 * `_dd` without `trace_id`/`span_id` is valid per the widened `RawRumResource` type from Step 1, no
 * cast needed.
 */
export class IpcResourceCollector {
  constructor(
    private eventManager: EventManager,
    registerHandler: (handler: (message: IpcChannelMessage) => void) => void = setIpcEventHandler
  ) {
    registerHandler(monitor((message: IpcChannelMessage) => this.processMessage(message)));
  }

  private processMessage(message: IpcChannelMessage): void {
    const rawRumEvent: RawRumResource = {
      type: 'resource',
      date: message.startTime as TimeStamp,
      resource: {
        id: generateUUID(),
        duration: toServerDuration(message.duration as Duration),
        type: 'native',
        url: message.channel,
      },
      _dd: {
        format_version: 2,
      },
      context: {
        ipc: {
          role: message.role,
          id: message.id,
          method: message.method,
        },
      },
    };

    this.eventManager.notify({
      kind: EventKind.RAW,
      format: EventFormat.RUM,
      data: rawRumEvent,
      startTime: rawRumEvent.date,
    });
  }
}
