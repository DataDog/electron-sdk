import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { contextBridge, ipcRenderer, bridgeEnabled } = vi.hoisted(() => {
  const state = { value: true as unknown };
  return {
    bridgeEnabled: state,
    contextBridge: { exposeInMainWorld: vi.fn() },
    ipcRenderer: {
      invoke: vi.fn(() => Promise.resolve('{}')),
      send: vi.fn(),
      on: vi.fn(),
      sendSync: vi.fn((channel: string) => (channel === 'datadog:flags-bridge-enabled' ? state.value : undefined)),
    },
  };
});

vi.mock('electron', () => ({ contextBridge, ipcRenderer }));

const page = globalThis as unknown as Record<string, unknown>;
// The preload declares `window`; in node tests it is globalThis.
page.window = globalThis;

interface Bridge {
  getSnapshot: () => Promise<string | undefined>;
  subscribe: (callback: (snapshot: string) => void) => () => void;
  sendEvaluations: (json: unknown) => void;
}

function resetFrame(contextIsolated: boolean) {
  delete page.__dd_flags_bridge_initialized;
  delete page.DatadogFlagsBridge;
  Object.defineProperty(process, 'contextIsolated', { value: contextIsolated, configurable: true });
  vi.clearAllMocks();
}

const { registerFlagsBridge } = await import('./flagsBridge');

const exposedBridge = () => contextBridge.exposeInMainWorld.mock.calls[0][1] as Bridge;
const pushUpdate = (snapshot: unknown) =>
  (ipcRenderer.on.mock.calls[0] as unknown as [string, (event: unknown, snapshot: unknown) => void])[1]({}, snapshot);

describe('flagsBridge', () => {
  beforeEach(() => {
    bridgeEnabled.value = true;
    resetFrame(true);
  });

  afterEach(() => {
    Object.defineProperty(process, 'contextIsolated', { value: undefined, configurable: true });
  });

  it('exposes DatadogFlagsBridge via contextBridge with contextIsolation', () => {
    registerFlagsBridge();
    expect(contextBridge.exposeInMainWorld).toHaveBeenCalledWith('DatadogFlagsBridge', expect.any(Object));
    expect(page.DatadogFlagsBridge).toBeUndefined();
  });

  it('sets the bridge on window without calling exposeInMainWorld when contextIsolation is off', () => {
    contextBridge.exposeInMainWorld.mockImplementation(() => {
      throw new Error('contextBridge API can only be used when contextIsolation is enabled');
    });
    resetFrame(false);
    expect(() => registerFlagsBridge()).not.toThrow();
    expect(contextBridge.exposeInMainWorld).not.toHaveBeenCalled();
    expect(typeof (page.DatadogFlagsBridge as Bridge).getSnapshot).toBe('function');
    contextBridge.exposeInMainWorld.mockReset();
  });

  it('getSnapshot invokes the snapshot channel', async () => {
    registerFlagsBridge();
    await expect(exposedBridge().getSnapshot()).resolves.toBe('{}');
    expect(ipcRenderer.invoke).toHaveBeenCalledWith('datadog:flags-snapshot');
  });

  it('subscribe fans out string updates and returns an unsubscribe', () => {
    registerFlagsBridge();
    const first = vi.fn();
    const second = vi.fn();
    const unsubscribeFirst = exposedBridge().subscribe(first);
    exposedBridge().subscribe(second);
    pushUpdate('snapshot-1');
    unsubscribeFirst();
    pushUpdate('snapshot-2');
    pushUpdate({ not: 'a string' });
    expect(first.mock.calls).toEqual([['snapshot-1']]);
    expect(second.mock.calls).toEqual([['snapshot-1'], ['snapshot-2']]);
  });

  it('sendEvaluations sends strings only', () => {
    registerFlagsBridge();
    exposedBridge().sendEvaluations('{"records":[]}');
    exposedBridge().sendEvaluations({ records: [] });
    expect(ipcRenderer.send.mock.calls).toEqual([['datadog:flags-evaluations', '{"records":[]}']]);
  });

  it('a second execution in the same frame keeps one bridge and one ipcRenderer listener', () => {
    registerFlagsBridge();
    registerFlagsBridge();
    expect(contextBridge.exposeInMainWorld).toHaveBeenCalledTimes(1);
    expect(ipcRenderer.on).toHaveBeenCalledTimes(1);
  });

  it('is not exposed at all when main answers that the session is excluded', () => {
    bridgeEnabled.value = false;
    registerFlagsBridge();
    expect(ipcRenderer.sendSync).toHaveBeenCalledWith('datadog:flags-bridge-enabled');
    expect(contextBridge.exposeInMainWorld).not.toHaveBeenCalled();
    expect(ipcRenderer.on).not.toHaveBeenCalled();
    resetFrame(false);
    bridgeEnabled.value = false;
    registerFlagsBridge();
    expect(page.DatadogFlagsBridge).toBeUndefined();
  });
});
