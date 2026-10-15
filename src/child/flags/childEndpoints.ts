import { isIndexableObject } from '@datadog/js-core/util';
import { display } from '../../tools/display';
import { decodeFrame, encodeFrame, isChildMessage, type ChildMessage } from '../../common/flags/childProtocol';

// `any` keeps the listener bivariant so both Node and Electron port typings are accepted.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Listener = (...args: any[]) => void;

/**
 * A message port the SDK owns: a Node `worker_threads` `MessagePort` or an Electron
 * `MessagePortMain`. Structural, so neither runtime type is imported. Node ports deliver
 * the message value; `MessagePortMain` delivers `{ data, ports }` and needs `start()`.
 */
export interface FlagsPortLike {
  postMessage(message: unknown): void;
  on(event: 'message' | 'close', listener: Listener): unknown;
  removeListener?(event: 'message' | 'close', listener: Listener): unknown;
  off?(event: 'message' | 'close', listener: Listener): unknown;
  start?(): void;
  unref?(): void;
  close?(): void;
}

/**
 * One end of a flags channel, the same on both sides: sends SDK envelopes, hands only SDK
 * envelopes to its handler (everything else is ignored silently) and never throws into the
 * app. A failing send warns once per endpoint, naming the channel.
 */
export interface FlagsEndpoint {
  send(message: ChildMessage): void;
  /** Start receiving; `onClose` runs once when the peer goes away. */
  setHandler(onMessage: (message: ChildMessage) => void, onClose?: () => void): void;
  /** Stop receiving and release the endpoint. Idempotent. */
  close(): void;
  readonly connected: boolean;
}

/** An endpoint over app-routed string frames, for `child_process` channels. */
export interface FlagsFramesEndpoint extends FlagsEndpoint {
  /** Hand a frame received on the app's channel to the SDK; non-SDK values are ignored. */
  receive(frame: unknown): void;
}

function createSendWarning(label: string) {
  let warned = false;
  return (error: unknown) => {
    if (!warned) {
      warned = true;
      display.warn(
        `Datadog feature flags channel "${label}" cannot send: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  };
}

/** Wrap an SDK-owned port. The port is started and unref'd where the runtime supports it. */
export function createPortEndpoint(port: FlagsPortLike, label: string): FlagsEndpoint {
  const warn = createSendWarning(label);
  let connected = true;
  let messageListener: Listener | undefined;
  let closeListener: Listener | undefined;

  const detach = () => {
    for (const [event, listener] of [
      ['message', messageListener],
      ['close', closeListener],
    ] as const) {
      if (listener !== undefined) {
        if (port.removeListener !== undefined) port.removeListener(event, listener);
        else port.off?.(event, listener);
      }
    }
    messageListener = undefined;
    closeListener = undefined;
  };

  return {
    get connected() {
      return connected;
    },
    send(message) {
      if (!connected) return;
      try {
        port.postMessage(message);
      } catch (error) {
        warn(error);
      }
    },
    setHandler(onMessage, onClose) {
      if (!connected || messageListener !== undefined) return;
      const onPortMessage = (event: unknown) => {
        const value = isMessagePortMainEvent(event) ? event.data : event;
        if (isChildMessage(value)) {
          onMessage(value);
        }
      };
      const onPortClose = () => {
        if (!connected) return;
        connected = false;
        detach();
        onClose?.();
      };
      messageListener = onPortMessage as Listener;
      closeListener = onPortClose as Listener;
      port.on('message', messageListener);
      port.on('close', closeListener);
      port.start?.();
      // The SDK port alone never keeps a worker or the main process alive.
      port.unref?.();
    },
    close() {
      if (!connected) return;
      connected = false;
      detach();
      try {
        port.close?.();
      } catch {
        // Already closed by the peer.
      }
    },
  };
}

/** Wrap an app-provided frame sender. The SDK adds no listener to any app object. */
export function createFramesEndpoint(send: (frame: string) => void, label: string): FlagsFramesEndpoint {
  const warn = createSendWarning(label);
  let connected = true;
  let handler: ((message: ChildMessage) => void) | undefined;
  return {
    get connected() {
      return connected;
    },
    send(message) {
      if (!connected) return;
      try {
        send(encodeFrame(message));
      } catch (error) {
        warn(error);
      }
    },
    setHandler(onMessage) {
      handler = onMessage;
    },
    receive(frame) {
      if (!connected || handler === undefined) return;
      const message = decodeFrame(frame);
      if (message !== undefined) {
        handler(message);
      }
    },
    close() {
      connected = false;
      handler = undefined;
    },
  };
}

/** The endpoint of a client connected without any channel: sends nothing, never receives. */
export function createDisconnectedEndpoint(): FlagsEndpoint {
  return {
    connected: false,
    send: () => undefined,
    setHandler: () => undefined,
    close: () => undefined,
  };
}

function isMessagePortMainEvent(event: unknown): event is { data: unknown; ports: unknown[] } {
  return isIndexableObject(event) && 'data' in event && Array.isArray(event.ports);
}
