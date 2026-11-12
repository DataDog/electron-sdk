import type { Duration, TimeStamp } from '@datadog/js-core/time';

// No runtime import: the sandboxed preload bundle imports src/common too.
export const IPC_HANDLE_CHANNEL = 'datadog:electron-sdk:ipc-handle';

/** A finished call to an instrumented IPC handler, published on {@link IPC_HANDLE_CHANNEL}. */
export interface IpcHandlerCall {
  channel: string;
  startTime: TimeStamp;
  duration: Duration;
  isError: boolean;
}
