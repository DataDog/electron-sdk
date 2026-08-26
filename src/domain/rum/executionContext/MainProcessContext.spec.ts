import { mockFs } from '../../../mocks.specUtil';

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/mock/user/data') },
}));

vi.mock('../../../tools/display', () => ({
  display: { error: vi.fn() },
}));

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MainProcessContext } from './MainProcessContext';
import { PROCESS_UPDATE_INTERVAL } from './constants';
import { EventManager, EventKind, EventFormat, EventSource, LifecycleKind, type RawRumEvent } from '../../../event';
import { createFormatHooks, type FormatHooks } from '../../../assembly';
import type { SessionManager } from '../../session';
import type { RawRumExecutionContext, RawRumView } from '../types';

vi.mock('node:fs/promises');
const mfs = mockFs();

describe('MainProcessContext', () => {
  let eventManager: EventManager;
  let hooks: FormatHooks;
  let rawRumEvents: RawRumEvent[];
  let currentSessionId: string;
  let sessionManager: SessionManager;
  let context: MainProcessContext;

  beforeEach(async () => {
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

    currentSessionId = 'session-1';
    sessionManager = { getSession: () => ({ id: currentSessionId, status: 'tracked' }) } as unknown as SessionManager;

    context = await MainProcessContext.start(eventManager, hooks, sessionManager);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    mfs.reset();
    context.stop();
  });

  it('emits a view and an execution_context event on start, cross-tagged with each other', () => {
    expect(rawRumEvents).toHaveLength(2);

    const view = rawRumEvents.find((e) => e.data.type === 'view')!;
    const executionContext = rawRumEvents.find((e) => e.data.type === 'execution_context')!;
    const viewData = view.data as RawRumView;
    const contextData = executionContext.data as RawRumExecutionContext;

    expect(viewData.view.id).toBe('session-1');
    expect(viewData.view.is_fake).toBe(true);
    expect(contextData.execution_context.type).toBe('main-process');
    expect(contextData.execution_context.instance_id).toBe(String(process.pid));

    expect(hooks.triggerRum({ eventType: 'view', startTime: view.startTime!, source: EventSource.MAIN })).toMatchObject(
      { execution_context: { id: contextData.execution_context.id } }
    );
    expect(
      hooks.triggerRum({
        eventType: 'execution_context',
        startTime: executionContext.startTime!,
        source: EventSource.MAIN,
      })
    ).toMatchObject({ view: { id: 'session-1' } });
  });

  it('SESSION_RENEW starts a new pair with a new execution_context.id but the same instance_id', () => {
    const initialContextId = (
      rawRumEvents.find((e) => e.data.type === 'execution_context')!.data as RawRumExecutionContext
    ).execution_context.id;

    currentSessionId = 'session-2';
    eventManager.notify({ kind: EventKind.LIFECYCLE, lifecycle: LifecycleKind.SESSION_RENEW });

    const newContextEvents = rawRumEvents.filter((e) => e.data.type === 'execution_context');
    const newContext = newContextEvents[newContextEvents.length - 1].data as RawRumExecutionContext;
    expect(newContext.execution_context.id).not.toBe(initialContextId);
    expect(newContext.execution_context.instance_id).toBe(String(process.pid));
    expect(newContext._dd.document_version).toBe(1);

    const newView = rawRumEvents.filter((e) => e.data.type === 'view').slice(-1)[0].data as RawRumView;
    expect(newView.view.id).toBe('session-2');
    expect(newView.view.is_active).toBe(true);
  });

  it('SESSION_EXPIRED emits a final inactive view and a final execution_context update with no exit_reason, at the pinned startTime', () => {
    const originalStartTime = rawRumEvents[0].startTime;
    // Advance the clock without reaching PROCESS_UPDATE_INTERVAL, so only the elapsed "now" moves
    // and no heartbeat fires in between.
    vi.advanceTimersByTime(PROCESS_UPDATE_INTERVAL / 2);
    rawRumEvents.length = 0;
    eventManager.notify({ kind: EventKind.LIFECYCLE, lifecycle: LifecycleKind.SESSION_EXPIRED });

    expect(rawRumEvents).toHaveLength(2);
    const view = rawRumEvents.find((e) => e.data.type === 'view')!;
    const executionContext = rawRumEvents.find((e) => e.data.type === 'execution_context')!;

    expect((view.data as RawRumView).view.is_active).toBe(false);
    expect((view.data as RawRumView)._dd.document_version).toBe(2);
    expect((executionContext.data as RawRumExecutionContext).execution_context.exit_reason).toBeUndefined();
    expect((executionContext.data as RawRumExecutionContext)._dd.document_version).toBe(2);
    // Both assembled at the pair's original pinned startTime, not a fresh now() read taken when
    // SESSION_EXPIRED actually fires (after the clock has already moved).
    expect(view.startTime).toBe(originalStartTime);
    expect(executionContext.startTime).toBe(originalStartTime);
  });

  it('heartbeat emits every PROCESS_UPDATE_INTERVAL, always at the pinned startTime', () => {
    const originalStartTime = rawRumEvents[0].startTime;
    rawRumEvents.length = 0;
    vi.advanceTimersByTime(PROCESS_UPDATE_INTERVAL);

    expect(rawRumEvents).toHaveLength(1);
    const heartbeat = rawRumEvents[0].data as RawRumExecutionContext;
    expect(heartbeat._dd.document_version).toBe(2);
    expect(heartbeat.execution_context.duration).toBeGreaterThanOrEqual(0);
    // Assembled at the pair's original pinned startTime, not a fresh now() read taken when the
    // heartbeat fires PROCESS_UPDATE_INTERVAL later.
    expect(rawRumEvents[0].startTime).toBe(originalStartTime);
  });

  it('SESSION_EXPIRED stops the heartbeat', () => {
    eventManager.notify({ kind: EventKind.LIFECYCLE, lifecycle: LifecycleKind.SESSION_EXPIRED });
    rawRumEvents.length = 0;
    vi.advanceTimersByTime(PROCESS_UPDATE_INTERVAL * 3);
    expect(rawRumEvents).toHaveLength(0);
  });

  it('stop() tears down the heartbeat', () => {
    context.stop();
    rawRumEvents.length = 0;
    vi.advanceTimersByTime(PROCESS_UPDATE_INTERVAL * 3);
    expect(rawRumEvents).toHaveLength(0);
  });

  it('resolves execution_context by time even after a SESSION_RENEW, matching what a replayed crash file needs', () => {
    const originalEvent = rawRumEvents.find((e) => e.data.type === 'execution_context')!;
    const originalStartTime = originalEvent.startTime!;
    const originalContextId = (originalEvent.data as RawRumExecutionContext).execution_context.id;

    vi.advanceTimersByTime(PROCESS_UPDATE_INTERVAL / 2);
    currentSessionId = 'session-2';
    eventManager.notify({ kind: EventKind.LIFECYCLE, lifecycle: LifecycleKind.SESSION_RENEW });

    const renewedEvent = rawRumEvents.filter((e) => e.data.type === 'execution_context').slice(-1)[0];
    const renewedStartTime = renewedEvent.startTime!;
    const renewedContextId = (renewedEvent.data as RawRumExecutionContext).execution_context.id;

    expect(
      hooks.triggerRum({ eventType: 'view', startTime: originalStartTime, source: EventSource.MAIN })
    ).toMatchObject({ execution_context: { id: originalContextId } });
    expect(
      hooks.triggerRum({ eventType: 'view', startTime: renewedStartTime, source: EventSource.MAIN })
    ).toMatchObject({ execution_context: { id: renewedContextId } });
  });

  describe('with a pre-existing history file left open by a previous run', () => {
    it('does not tag the new pair with the stale entry', async () => {
      context.stop();
      mfs.readFile.mockResolvedValue(
        JSON.stringify([{ value: { id: 'stale-id', type: 'main-process' }, startTime: 0, endTime: null }])
      );

      const localEventManager = new EventManager();
      const localHooks = createFormatHooks();
      const localRawRumEvents: RawRumEvent[] = [];
      localEventManager.registerHandler<RawRumEvent>({
        canHandle: (e): e is RawRumEvent => e.kind === EventKind.RAW && e.format === EventFormat.RUM,
        handle: (e) => localRawRumEvents.push(e),
      });
      const localSessionManager = {
        getSession: () => ({ id: 'session-new', status: 'tracked' }),
      } as unknown as SessionManager;

      const localContext = await MainProcessContext.start(localEventManager, localHooks, localSessionManager);

      const newContextEvent = localRawRumEvents.find((e) => e.data.type === 'execution_context')!;
      const newContextId = (newContextEvent.data as RawRumExecutionContext).execution_context.id;
      expect(newContextId).not.toBe('stale-id');

      expect(
        localHooks.triggerRum({
          eventType: 'view',
          startTime: newContextEvent.startTime!,
          source: EventSource.MAIN,
        })
      ).toMatchObject({ execution_context: { id: newContextId } });

      localContext.stop();
    });
  });
});
