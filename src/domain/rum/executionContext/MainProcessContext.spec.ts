import { mockFs } from '../../../mocks.specUtil';

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/mock/user/data') },
}));

vi.mock('../../../tools/display', () => ({
  display: { error: vi.fn() },
}));

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { timeStampNow, type TimeStamp } from '@datadog/js-core/time';
import { DISCARDED } from '@datadog/js-core/assembly';
import { MainProcessContext, MAIN_EXECUTION_CONTEXT_HISTORY_FILE_NAME } from './MainProcessContext';
import { PROCESS_UPDATE_INTERVAL } from './executionContext.constants';
import { EventManager, EventKind, EventFormat, EventSource, LifecycleKind, type RawRumEvent } from '../../../event';
import { createFormatHooks, type FormatHooks } from '../../../assembly';
import type { SessionManager } from '../../session';
import type { RawRumExecutionContext, RawRumView } from '../types';
import { TrackingConsentManager } from '../../tracking-consent';

vi.mock('node:fs/promises');
const mfs = mockFs();

describe('MainProcessContext', () => {
  let eventManager: EventManager;
  let hooks: FormatHooks;
  let rawRumEvents: RawRumEvent[];
  let currentSessionId: string;
  let sessionManager: SessionManager;
  let context: MainProcessContext;
  let trackingConsentManager: TrackingConsentManager;

  beforeEach(async () => {
    vi.useFakeTimers();
    trackingConsentManager = new TrackingConsentManager();
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

    context = await MainProcessContext.start(eventManager, hooks, sessionManager, trackingConsentManager);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    mfs.reset();
    context.stop();
  });

  it('emits a view and an execution_context event on start, cross-tagged with each other', async () => {
    expect(rawRumEvents).toHaveLength(2);

    const view = rawRumEvents.find((e) => e.data.type === 'view')!;
    const executionContext = rawRumEvents.find((e) => e.data.type === 'execution_context')!;
    const viewData = view.data as RawRumView;
    const contextData = executionContext.data as RawRumExecutionContext;

    expect(viewData.view.id).toBe('session-1');
    expect(viewData.view.is_fake).toBe(true);
    expect(contextData.execution_context.type).toBe('main-process');
    expect(contextData.execution_context.name).toBe('Main Process');
    expect(contextData.execution_context.instance_id).toBe(String(process.pid));

    expect(hooks.triggerRum({ eventType: 'view', startTime: view.startTime!, source: EventSource.MAIN })).toMatchObject(
      { execution_context: { id: contextData.execution_context.id, name: 'Main Process' } }
    );
    expect(
      hooks.triggerRum({
        eventType: 'execution_context',
        startTime: executionContext.startTime!,
        source: EventSource.MAIN,
      })
    ).toMatchObject({ view: { id: 'session-1' } });

    await vi.advanceTimersByTimeAsync(0);
    expect(mfs.writeFile).toHaveBeenCalledWith(
      `/mock/user/data/${MAIN_EXECUTION_CONTEXT_HISTORY_FILE_NAME}`,
      expect.stringContaining(contextData.execution_context.id),
      'utf-8'
    );
  });

  it('does not tag an execution_context event with its own execution_context field', () => {
    // Regression: this hook must not tag execution_context events at all — otherwise combine()
    // lets its name fill in for any execution_context event (main's own or a renderer's) whose
    // own name hasn't resolved yet (undefined at emit time), since both reach here with source
    // MAIN — RendererProcessContexts's own tagging code also runs in the main process.
    const executionContext = rawRumEvents.find((e) => e.data.type === 'execution_context')!;
    const result = hooks.triggerRum({
      eventType: 'execution_context',
      startTime: executionContext.startTime!,
      source: EventSource.MAIN,
    }) as { execution_context?: unknown };
    expect(result.execution_context).toBeUndefined();
  });

  it('span hook tags spans within the pair with _dd.execution_context.id', () => {
    const executionContext = rawRumEvents.find((e) => e.data.type === 'execution_context')!;
    const contextData = (executionContext.data as RawRumExecutionContext).execution_context;

    expect(hooks.triggerSpan({ startTime: executionContext.startTime!, source: EventSource.MAIN })).toMatchObject({
      meta: { '_dd.execution_context.id': contextData.id },
    });
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

  it('closes the view and execution_context histories on SESSION_EXPIRED, so telemetry during the gap resolves to neither', () => {
    eventManager.notify({ kind: EventKind.LIFECYCLE, lifecycle: LifecycleKind.SESSION_EXPIRED });
    vi.advanceTimersByTime(PROCESS_UPDATE_INTERVAL / 2);
    const duringTheGap = timeStampNow();

    // ViewContext's own hook discards any main-sourced RUM event with no active view outright —
    // pre-existing, unrelated to this fix — so a closed view history surfaces as DISCARDED here.
    expect(hooks.triggerRum({ eventType: 'view', startTime: duringTheGap, source: EventSource.MAIN })).toBe(DISCARDED);
    // Spans only consult mainHistory (not viewContext), so this specifically exercises that
    // mainHistory.closeActive() was actually called — the fix under test.
    expect(hooks.triggerSpan({ startTime: duringTheGap, source: EventSource.MAIN })).toBe(DISCARDED);
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

  it('creates no state or heartbeat until initially denied consent becomes enabled', async () => {
    context.stop();
    trackingConsentManager.update('not-granted');
    hooks = createFormatHooks();
    rawRumEvents.length = 0;
    context = await MainProcessContext.start(eventManager, hooks, sessionManager, trackingConsentManager);

    eventManager.notify({ kind: EventKind.LIFECYCLE, lifecycle: LifecycleKind.SESSION_RENEW });
    vi.advanceTimersByTime(PROCESS_UPDATE_INTERVAL);
    expect(rawRumEvents).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);

    const acceptedAt = timeStampNow();
    trackingConsentManager.update('granted');

    expect(rawRumEvents).toHaveLength(2);
    expect(rawRumEvents.map((event) => event.startTime)).toEqual([acceptedAt, acceptedAt]);
    rawRumEvents.length = 0;
    vi.advanceTimersByTime(PROCESS_UPDATE_INTERVAL);
    expect(rawRumEvents).toHaveLength(1);
  });

  it.each(['pending', 'granted'] as const)('starts a distinct cumulative period when consent becomes %s', (next) => {
    if (next === 'granted') trackingConsentManager.update('pending');
    const previousView = rawRumEvents.filter((event) => event.data.type === 'view').slice(-1)[0].data as RawRumView;
    const previousContext = rawRumEvents.filter((event) => event.data.type === 'execution_context').slice(-1)[0]
      .data as RawRumExecutionContext;
    rawRumEvents.length = 0;
    vi.advanceTimersByTime(10);
    const boundary = timeStampNow();

    trackingConsentManager.update(next);

    expect(rawRumEvents).toHaveLength(4);
    expect(rawRumEvents[0].data).toMatchObject({
      view: { id: previousView.view.id, is_active: false, time_spent: 10e6 },
    });
    expect(rawRumEvents[1].data).toMatchObject({
      execution_context: { id: previousContext.execution_context.id, duration: 10e6 },
    });
    const nextView = rawRumEvents[2].data as RawRumView;
    const nextContext = rawRumEvents[3].data as RawRumExecutionContext;
    expect(nextView.view.id).not.toBe(previousView.view.id);
    expect(nextView.view.id).not.toBe(currentSessionId);
    expect(nextContext.execution_context.id).not.toBe(previousContext.execution_context.id);
    expect(nextView._dd.document_version).toBe(1);
    expect(nextContext.execution_context.duration).toBe(0);
    expect(hooks.triggerRum({ eventType: 'error', source: EventSource.MAIN, startTime: boundary })).toMatchObject({
      view: { id: nextView.view.id },
      execution_context: { id: nextContext.execution_context.id },
    });

    rawRumEvents.length = 0;
    vi.advanceTimersByTime(PROCESS_UPDATE_INTERVAL);
    expect(rawRumEvents).toHaveLength(1);
  });

  it('closes at the supplied session boundary and ignores repeated expiry', () => {
    const boundary = (timeStampNow() + 10) as TimeStamp;
    vi.advanceTimersByTime(20);
    rawRumEvents.length = 0;
    eventManager.notify({ kind: EventKind.LIFECYCLE, lifecycle: LifecycleKind.SESSION_EXPIRED, time: boundary });
    eventManager.notify({ kind: EventKind.LIFECYCLE, lifecycle: LifecycleKind.SESSION_EXPIRED });

    expect(rawRumEvents).toHaveLength(2);
    expect(rawRumEvents[0].data).toMatchObject({ view: { time_spent: 10e6, is_active: false } });
    expect(rawRumEvents[1].data).toMatchObject({ execution_context: { duration: 10e6 } });
  });

  it('does not rotate twice when an earlier consent observer renews the session', async () => {
    context.stop();
    hooks = createFormatHooks();
    trackingConsentManager = new TrackingConsentManager();
    trackingConsentManager.subscribe((change) => {
      eventManager.notify({ kind: EventKind.LIFECYCLE, lifecycle: LifecycleKind.SESSION_RENEW, time: change.time });
    });
    context = await MainProcessContext.start(eventManager, hooks, sessionManager, trackingConsentManager);
    eventManager.notify({ kind: EventKind.LIFECYCLE, lifecycle: LifecycleKind.SESSION_EXPIRED });
    rawRumEvents.length = 0;

    trackingConsentManager.update('pending');

    expect(rawRumEvents).toHaveLength(2);
    expect(
      rawRumEvents.map((event) => (event.data as RawRumView | RawRumExecutionContext)._dd.document_version)
    ).toEqual([1, 1]);
    rawRumEvents.length = 0;
    vi.advanceTimersByTime(PROCESS_UPDATE_INTERVAL);
    expect(rawRumEvents).toHaveLength(1);
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

  it('keeps both pending histories off disk and discards their RUM and span attribution on refusal', async () => {
    vi.advanceTimersByTime(10);
    const pendingStart = timeStampNow();
    trackingConsentManager.update('pending');
    await vi.advanceTimersByTimeAsync(0);
    mfs.writeFile.mockClear();

    currentSessionId = 'pending-session';
    eventManager.notify({ kind: EventKind.LIFECYCLE, lifecycle: LifecycleKind.SESSION_RENEW });
    const pendingEvent = rawRumEvents.filter((event) => event.data.type === 'execution_context').slice(-1)[0];
    const pendingId = (pendingEvent.data as RawRumExecutionContext).execution_context.id;
    await vi.advanceTimersByTimeAsync(0);

    expect(hooks.triggerRum({ eventType: 'error', startTime: pendingStart, source: EventSource.MAIN })).toMatchObject({
      view: { id: 'pending-session' },
      execution_context: { id: pendingId },
    });
    expect(mfs.writeFile).not.toHaveBeenCalled();

    vi.advanceTimersByTime(10);
    trackingConsentManager.update('not-granted');
    expect(hooks.triggerRum({ eventType: 'error', startTime: pendingStart, source: EventSource.MAIN })).toBe(DISCARDED);
    expect(hooks.triggerSpan({ startTime: pendingStart, source: EventSource.MAIN })).toBe(DISCARDED);
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

      const localContext = await MainProcessContext.start(
        localEventManager,
        localHooks,
        localSessionManager,
        trackingConsentManager
      );

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
