import { generateUUID } from '@datadog/browser-core';
import { contextBridge, ipcRenderer } from 'electron';
import type { ResourceHandler } from '../domain/tracing/ipcResourceBridgeTypes';
import { isExcludedIpcChannel } from '../domain/tracing/ipcChannelFilter';

export type { ResourceHandlerEvent, ResourceHandler } from '../domain/tracing/ipcResourceBridgeTypes';

interface IpcRendererLike {
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
  send: (channel: string, ...args: unknown[]) => void;
  on: (channel: string, listener: (event: unknown, ...args: unknown[]) => void) => unknown;
}

interface IpcIdCarrier {
  __ddIpcId: string;
}

function isIpcIdCarrier(value: unknown): value is IpcIdCarrier {
  return typeof value === 'object' && value !== null && typeof (value as IpcIdCarrier).__ddIpcId === 'string';
}

function extractIpcId(args: unknown[]): { id: string | undefined; strippedArgs: unknown[] } {
  const last = args[args.length - 1];
  if (isIpcIdCarrier(last)) {
    return { id: last.__ddIpcId, strippedArgs: args.slice(0, -1) };
  }
  return { id: undefined, strippedArgs: args };
}

export function patchIpcRenderer(ipcRendererLike: IpcRendererLike): {
  registerResourceHandler: (handler: ResourceHandler) => void;
} {
  let handler: ResourceHandler | undefined;

  const rawInvoke = ipcRendererLike.invoke.bind(ipcRendererLike);
  const rawSend = ipcRendererLike.send.bind(ipcRendererLike);
  const rawOn = ipcRendererLike.on.bind(ipcRendererLike);

  ipcRendererLike.invoke = (channel: string, ...args: unknown[]) => {
    if (isExcludedIpcChannel(channel)) {
      return rawInvoke(channel, ...args);
    }

    const id = generateUUID();
    handler?.({ action: 'start', url: channel });
    return rawInvoke(channel, ...args, { __ddIpcId: id }).then(
      (value) => {
        handler?.({
          action: 'stop',
          url: channel,
          options: { context: { ipc: { role: 'source', id, method: 'invoke' } } },
        });
        return value;
      },
      (err: unknown) => {
        handler?.({
          action: 'stop',
          url: channel,
          options: { context: { ipc: { role: 'source', id, method: 'invoke', error: true } } },
        });
        throw err;
      }
    );
  };

  ipcRendererLike.send = (channel: string, ...args: unknown[]) => {
    if (isExcludedIpcChannel(channel)) {
      rawSend(channel, ...args);
      return;
    }

    const id = generateUUID();
    handler?.({ action: 'start', url: channel });
    rawSend(channel, ...args, { __ddIpcId: id });
    handler?.({
      action: 'stop',
      url: channel,
      options: { context: { ipc: { role: 'source', id, method: 'send' } } },
    });
  };

  ipcRendererLike.on = (channel: string, listener: (event: unknown, ...args: unknown[]) => void) => {
    if (isExcludedIpcChannel(channel)) {
      return rawOn(channel, listener);
    }

    return rawOn(channel, (event: unknown, ...args: unknown[]) => {
      const { id, strippedArgs } = extractIpcId(args);
      handler?.({ action: 'start', url: channel });
      try {
        listener(event, ...strippedArgs);
        if (id) {
          handler?.({
            action: 'stop',
            url: channel,
            options: { context: { ipc: { role: 'destination', id, method: 'on' } } },
          });
        }
      } catch (err) {
        if (id) {
          handler?.({
            action: 'stop',
            url: channel,
            options: { context: { ipc: { role: 'destination', id, method: 'on', error: true } } },
          });
        }
        throw err;
      }
    });
  };

  return {
    registerResourceHandler(newHandler: ResourceHandler) {
      handler = newHandler;
    },
  };
}

declare const window: Record<string, unknown>;

const DD_IPC_BRIDGE_INIT = '__dd_ipc_bridge_initialized';

if (!window[DD_IPC_BRIDGE_INIT]) {
  window[DD_IPC_BRIDGE_INIT] = true;

  const { registerResourceHandler } = patchIpcRenderer(ipcRenderer);

  const ipcBridge = {
    registerResourceHandler(handler: ResourceHandler): void {
      registerResourceHandler(handler);
    },
  };

  window.DatadogIpcBridge = ipcBridge;

  try {
    contextBridge.exposeInMainWorld('DatadogIpcBridge', ipcBridge);
  } catch {
    // exposeInMainWorld throws when contextIsolation is disabled
  }
}
