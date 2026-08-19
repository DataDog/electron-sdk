/// <reference types="vitest/globals" />
/// <reference lib="dom" />

/**
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: vi.fn() },
  ipcRenderer: { invoke: vi.fn(), send: vi.fn(), on: vi.fn() },
}));

import { patchIpcRenderer } from './ipc';

describe('patchIpcRenderer', () => {
  it('appends a generated ipc.id to invoke calls and calls the resource handler on settle', async () => {
    const calls: unknown[][] = [];
    const fakeIpcRenderer = {
      invoke: vi.fn((_channel: string, ...args: unknown[]) => {
        calls.push(args);
        return Promise.resolve('ok');
      }),
      send: vi.fn(),
      on: vi.fn(),
    };

    const handler = vi.fn();
    const { registerResourceHandler } = patchIpcRenderer(fakeIpcRenderer);
    registerResourceHandler(handler);

    await fakeIpcRenderer.invoke('get-profile', 'userId123');

    // The real ipcRenderer.invoke was called with the id appended as the last argument.
    expect(calls[0][0]).toBe('userId123');
    expect(calls[0][1]).toEqual({
      __ddIpcId: expect.any(String) as unknown,
      __ddParentIds: [],
    });
    const wireId = (calls[0][1] as { __ddIpcId: string }).__ddIpcId;

    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ action: 'start', url: 'get-profile' }));
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'stop',
        url: 'get-profile',
        options: expect.objectContaining({
          context: { ipc: { role: 'source', id: wireId, parent_ids: [], method: 'invoke' } },
        }) as unknown,
      })
    );
  });

  it('passes datadog: channels through untouched (no ipc.id, no resource events)', async () => {
    const invokeCalls: unknown[][] = [];
    const sendCalls: unknown[][] = [];
    const onListener = vi.fn();
    const fakeIpcRenderer = {
      invoke: vi.fn((_channel: string, ...args: unknown[]) => {
        invokeCalls.push(args);
        return Promise.resolve('ok');
      }),
      send: vi.fn((_channel: string, ...args: unknown[]) => {
        sendCalls.push(args);
      }),
      on: vi.fn((_channel: string, listener: (event: unknown, ...args: unknown[]) => void) => listener),
    };

    const handler = vi.fn();
    const { registerResourceHandler } = patchIpcRenderer(fakeIpcRenderer);
    registerResourceHandler(handler);

    await fakeIpcRenderer.invoke('datadog:bridge-send', 'payload');
    fakeIpcRenderer.send('datadog:bridge-send', 'payload');
    const registeredListener = fakeIpcRenderer.on('datadog:bridge-send', onListener);
    registeredListener('event', 'arg1');

    expect(invokeCalls[0]).toEqual(['payload']);
    expect(sendCalls[0]).toEqual(['payload']);
    expect(onListener).toHaveBeenCalledWith('event', 'arg1');
    expect(handler).not.toHaveBeenCalled();
  });

  it('an invoke made synchronously from within an on listener inherits that listener as its parent', async () => {
    const listeners: Record<string, (event: unknown, ...args: unknown[]) => void> = {};
    const invokeCalls: unknown[][] = [];
    let followUpPromise: Promise<unknown> | undefined;
    const fakeIpcRenderer = {
      invoke: vi.fn((_channel: string, ...args: unknown[]) => {
        invokeCalls.push(args);
        return Promise.resolve('ok');
      }),
      send: vi.fn(),
      on: vi.fn((channel: string, listener: (event: unknown, ...args: unknown[]) => void) => {
        listeners[channel] = listener;
      }),
    };

    const events: unknown[] = [];
    const { registerResourceHandler } = patchIpcRenderer(fakeIpcRenderer);
    registerResourceHandler((event) => events.push(event));

    fakeIpcRenderer.on('ipc-demo:ping-renderer', () => {
      followUpPromise = fakeIpcRenderer.invoke('ipc-demo:follow-up');
    });
    listeners['ipc-demo:ping-renderer']('event', { __ddIpcId: 'call-A', __ddParentIds: [] });
    await followUpPromise;

    // The follow-up invoke's carrier must inherit ['call-A'] as its parent chain.
    const followUpArgs = invokeCalls[0];
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    expect(followUpArgs[0]).toEqual({ __ddIpcId: expect.any(String), __ddParentIds: ['call-A'] });

    const followUpStop = events.find(
      (e) =>
        (e as { url?: string; action?: string }).url === 'ipc-demo:follow-up' &&
        (e as { action?: string }).action === 'stop'
    ) as { options?: { context?: { ipc?: { parent_ids?: string[] } } } };
    expect(followUpStop.options?.context?.ipc?.parent_ids).toEqual(['call-A']);
  });

  it('an invoke made outside any on listener has no parent ids', async () => {
    const invokeCalls: unknown[][] = [];
    const fakeIpcRenderer = {
      invoke: vi.fn((_channel: string, ...args: unknown[]) => {
        invokeCalls.push(args);
        return Promise.resolve('ok');
      }),
      send: vi.fn(),
      on: vi.fn(),
    };

    const { registerResourceHandler } = patchIpcRenderer(fakeIpcRenderer);
    registerResourceHandler(() => undefined);

    await fakeIpcRenderer.invoke('ipc-demo:standalone');

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    expect(invokeCalls[0][0]).toEqual({ __ddIpcId: expect.any(String), __ddParentIds: [] });
  });
});
