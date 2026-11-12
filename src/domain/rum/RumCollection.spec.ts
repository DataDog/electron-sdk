import { createTestConfiguration, mockFs } from '../../mocks.specUtil';

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/mock/user/data'),
    getName: vi.fn(() => 'TestApp'),
    on: vi.fn(),
    removeListener: vi.fn(),
    whenReady: vi.fn(() => new Promise<void>(() => undefined)),
  },
  crashReporter: { start: vi.fn() },
  webContents: { getAllWebContents: vi.fn(() => []) },
}));

vi.mock('../../tools/display', () => ({
  display: { error: vi.fn() },
}));

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as DiagnosticsChannel from 'node:diagnostics_channel';
import { IPC_HANDLE_CHANNEL } from '../../common';
import { RumCollection } from './RumCollection';
import { EventManager, EventKind, EventFormat, type RawRumEvent } from '../../event';
import { createFormatHooks, type FormatHooks } from '../../assembly';
import type { SessionManager } from '../session';
import type { RawRumView } from './types';
import { PROCESS_UPDATE_INTERVAL } from './executionContext';

vi.mock('node:fs/promises');
const mfs = mockFs();

describe('RumCollection', () => {
  let eventManager: EventManager;
  let hooks: FormatHooks;
  let rawRumEvents: RawRumEvent[];
  let sessionManager: SessionManager;

  beforeEach(() => {
    vi.useFakeTimers();
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
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    mfs.reset();
  });

  it('uses MainProcessContext and starts ExecutionContextCollection', async () => {
    const rum = await RumCollection.start(eventManager, hooks, sessionManager, createTestConfiguration());

    const viewEvent = rawRumEvents.find((e) => e.data.type === 'view');
    expect((viewEvent!.data as RawRumView).view.id).toBe('session-1');

    // ExecutionContextCollection.start() emits an initial main-process execution_context event
    const executionContextEvent = rawRumEvents.find((e) => e.data.type === 'execution_context');
    expect(executionContextEvent).toBeDefined();

    rum.stop();
  });

  it('stop() also stops ExecutionContextCollection', async () => {
    const rum = await RumCollection.start(eventManager, hooks, sessionManager, createTestConfiguration());

    rum.stop();
    rawRumEvents.length = 0;

    vi.advanceTimersByTime(PROCESS_UPDATE_INTERVAL * 3);

    // No further execution_context heartbeat once the underlying ExecutionContextCollection is stopped
    expect(rawRumEvents.find((e) => e.data.type === 'execution_context')).toBeUndefined();
  });

  describe('IPC resources', () => {
    function publishHandlerCall() {
      DiagnosticsChannel.channel(IPC_HANDLE_CHANNEL).publish({
        channel: 'settings:get',
        startTime: 0,
        duration: 1,
        isError: false,
      });
    }

    it.each([
      { trackIpcResources: true, expectedCount: 1 },
      { trackIpcResources: false, expectedCount: 0 },
    ])(
      'reports $expectedCount resource for a handler call when trackIpcResources is $trackIpcResources',
      async ({ trackIpcResources, expectedCount }) => {
        const rum = await RumCollection.start(
          eventManager,
          hooks,
          sessionManager,
          createTestConfiguration({ trackIpcResources })
        );

        publishHandlerCall();

        expect(rawRumEvents.filter((e) => e.data.type === 'resource')).toHaveLength(expectedCount);
        rum.stop();
      }
    );

    it('stop() also stops reporting handler calls', async () => {
      const rum = await RumCollection.start(
        eventManager,
        hooks,
        sessionManager,
        createTestConfiguration({ trackIpcResources: true })
      );

      rum.stop();
      publishHandlerCall();

      expect(rawRumEvents.filter((e) => e.data.type === 'resource')).toEqual([]);
    });
  });
});
