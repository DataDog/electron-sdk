import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { tracingChannel } from 'node:diagnostics_channel';

const mockSpan = {
  finish: vi.fn(),
  setTag: vi.fn(),
};
const mockScope = {
  activate: vi.fn((_span, fn?: () => unknown) => fn?.()),
};
const mockTracer = {
  startSpan: vi.fn(() => mockSpan),
  inject: vi.fn(),
  extract: vi.fn(() => null),
  scope: vi.fn(() => mockScope),
};

vi.mock('dd-trace', () => ({ default: mockTracer }));

describe('ElectronInstrumentation - IPC receive spans', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let instances: any[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    for (const inst of instances) {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      inst.stop();
    }
    instances = [];
  });

  it('creates a consumer span when ipcMain.handle fires', async () => {
    const { ElectronInstrumentation } = await import('./ElectronInstrumentation');
    const inst = new ElectronInstrumentation();
    instances.push(inst);

    const ch = tracingChannel<{ args: unknown[]; channel: string; event?: unknown }>('apm:electron:ipc:main:handle');
    const ctx = { args: [], channel: 'ping', event: {} };
    ch.start.publish(ctx);
    ch.asyncEnd.publish(ctx);

    expect(mockTracer.startSpan).toHaveBeenCalledWith(
      'electron.main.handle',
      expect.objectContaining({
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        tags: expect.objectContaining({
          'span.kind': 'consumer',
          'resource.name': 'ping',
        }),
      })
    );
    expect(mockSpan.finish).toHaveBeenCalled();
  });

  it('skips spans for datadog: internal channels', async () => {
    const { ElectronInstrumentation } = await import('./ElectronInstrumentation');
    const inst = new ElectronInstrumentation();
    instances.push(inst);

    const ch = tracingChannel<{ args: unknown[]; channel: string }>('apm:electron:ipc:main:receive');
    ch.start.publish({ args: [], channel: 'datadog:bridge-send' });

    expect(mockTracer.startSpan).not.toHaveBeenCalled();
  });

  it('stop() unsubscribes all channels', async () => {
    const { ElectronInstrumentation } = await import('./ElectronInstrumentation');
    const inst = new ElectronInstrumentation();
    inst.stop();

    const ch = tracingChannel<{ args: unknown[]; channel: string }>('apm:electron:ipc:main:handle');
    ch.start.publish({ args: [], channel: 'ping' });

    expect(mockTracer.startSpan).not.toHaveBeenCalled();
  });
});
