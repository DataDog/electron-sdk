import { mockFs } from '../../../mocks.specUtil';

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/mock/user/data'),
    on: vi.fn(),
    removeListener: vi.fn(),
  },
}));

vi.mock('../../../tools/display', () => ({
  display: { error: vi.fn() },
}));

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { app } from 'electron';
import { ExecutionContextCollection } from './ExecutionContextCollection';
import { PROCESS_UPDATE_INTERVAL } from './executionContext.constants';
import { EventManager, EventKind, EventFormat, EventSource, type RawRumEvent } from '../../../event';
import { createFormatHooks } from '../../../assembly';
import type { SessionManager } from '../../session';
import type { RawRumExecutionContext } from '../types';

vi.mock('node:fs/promises');
const mfs = mockFs();

describe('ExecutionContextCollection', () => {
  let eventManager: EventManager;
  let hooks: ReturnType<typeof createFormatHooks>;
  let rawRumEvents: RawRumEvent[];
  let sessionManager: SessionManager;
  let collection: ExecutionContextCollection;
  let webContentsCreatedHandler: (event: unknown, webContents: unknown) => void;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    mfs.readFile.mockRejectedValue(new Error('ENOENT'));
    mfs.writeFile.mockResolvedValue(undefined);

    eventManager = new EventManager();
    hooks = createFormatHooks();
    rawRumEvents = [];
    eventManager.registerHandler<RawRumEvent>({
      canHandle: (e): e is RawRumEvent => e.kind === EventKind.RAW && e.format === EventFormat.RUM,
      handle: (e) => rawRumEvents.push(e),
    });

    sessionManager = { getSession: () => ({ id: 'session-1', status: 'tracked' }) } as unknown as SessionManager;

    vi.mocked(app).on.mockImplementation((event: string, handler: (...args: unknown[]) => void) => {
      if (event === 'web-contents-created') {
        webContentsCreatedHandler = handler;
      }
      return app;
    });

    collection = await ExecutionContextCollection.start(eventManager, hooks, sessionManager);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    mfs.reset();
    collection.stop();
  });

  it('starts a main execution context and readies renderer tracking together', () => {
    const mainEvent = rawRumEvents.find((e) => e.data.type === 'execution_context')!.data as RawRumExecutionContext;
    expect(mainEvent.execution_context.type).toBe('main-process');
    expect(mainEvent.execution_context.instance_id).toBe(String(process.pid));

    const countBeforeRenderer = rawRumEvents.length;
    webContentsCreatedHandler(
      {},
      {
        id: 1,
        on: vi.fn(),
      }
    );
    const rendererEvent = rawRumEvents[rawRumEvents.length - 1].data as RawRumExecutionContext;
    expect(rawRumEvents).toHaveLength(countBeforeRenderer + 1);
    expect(rendererEvent.execution_context.type).toBe('renderer-process');

    expect(
      hooks.triggerRum({ eventType: 'view', startTime: 0 as never, source: EventSource.RENDERER, webContentsId: 1 })
    ).toMatchObject({ execution_context: { id: rendererEvent.execution_context.id, type: 'renderer-process' } });
  });

  it('stop() stops both the main heartbeat and renderer tracking', () => {
    webContentsCreatedHandler(
      {},
      {
        id: 1,
        on: vi.fn(),
      }
    );
    const countAfterStart = rawRumEvents.length;

    collection.stop();
    rawRumEvents.length = 0;
    vi.advanceTimersByTime(PROCESS_UPDATE_INTERVAL * 3);

    expect(rawRumEvents).toHaveLength(0);
    expect(countAfterStart).toBeGreaterThan(0);
  });
});
