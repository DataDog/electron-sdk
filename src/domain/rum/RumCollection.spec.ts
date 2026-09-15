import { mockFs } from '../../mocks.specUtil';

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/mock/user/data'),
    getName: vi.fn(() => 'TestApp'),
    on: vi.fn(),
    removeListener: vi.fn(),
    whenReady: vi.fn(() => new Promise<void>(() => undefined)),
  },
  crashReporter: { start: vi.fn() },
}));

vi.mock('../../tools/display', () => ({
  display: { error: vi.fn() },
}));

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RumCollection } from './RumCollection';
import { EventManager, EventKind, EventFormat, type RawRumEvent } from '../../event';
import { createFormatHooks, type FormatHooks } from '../../assembly';
import type { Configuration } from '../../config';
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

  it('uses ViewCollection when enableExecutionContext is false', async () => {
    const configuration = { enableExecutionContext: false } as Configuration;
    const rum = await RumCollection.start(eventManager, hooks, sessionManager, configuration);
    // ViewCollection.start emits the real generateUUID-based view id, not the session id
    expect((rawRumEvents[0].data as RawRumView).view.id).not.toBe(sessionManager.getSession().id);
    // ExecutionContextCollection must stay unstarted on the disabled path — no execution_context event
    expect(rawRumEvents.find((e) => e.data.type === 'execution_context')).toBeUndefined();
    rum.stop();
  });

  it('uses MainProcessContext and starts ExecutionContextCollection when enableExecutionContext is true', async () => {
    const configuration = { enableExecutionContext: true } as Configuration;
    const rum = await RumCollection.start(eventManager, hooks, sessionManager, configuration);

    const viewEvent = rawRumEvents.find((e) => e.data.type === 'view');
    expect((viewEvent!.data as RawRumView).view.id).toBe(sessionManager.getSession().id);

    // ExecutionContextCollection.start() emits an initial main-process execution_context event
    const executionContextEvent = rawRumEvents.find((e) => e.data.type === 'execution_context');
    expect(executionContextEvent).toBeDefined();

    rum.stop();
  });

  it('stop() also stops ExecutionContextCollection when enableExecutionContext is true', async () => {
    const configuration = { enableExecutionContext: true } as Configuration;
    const rum = await RumCollection.start(eventManager, hooks, sessionManager, configuration);

    rum.stop();
    rawRumEvents.length = 0;

    vi.advanceTimersByTime(PROCESS_UPDATE_INTERVAL * 3);

    // No further execution_context heartbeat once the underlying ExecutionContextCollection is stopped
    expect(rawRumEvents.find((e) => e.data.type === 'execution_context')).toBeUndefined();
  });
});
