import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DISCARDED } from '@datadog/js-core/assembly';
import type { TimeStamp } from '@datadog/js-core/time';
import { BeforeSend, createFormatHooks, MainAssembly, type FormatHooks } from '../../assembly';
import { EventFormat, EventKind, EventManager, EventSource, type RawRumEvent, type ServerEvent } from '../../event';
import { createTestConfiguration, mockFs } from '../../mocks.specUtil';
import { ConsentAwareBatchRouter, type BatchProducer } from '../../transport/batch';
import { SessionManager } from '../session';
import { ContextHistoryFactory, TrackingConsentManager, type TrackingConsent } from '../tracking-consent';
import { ExecutionContextCollection } from './executionContext';
import { ViewCollection, VIEW_HISTORY_FILE_NAME } from './view';
import type { RawRumView } from './types';

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  return {
    app: Object.assign(new EventEmitter(), { getPath: () => '/mock/user/data' }),
    webContents: { getAllWebContents: () => [] },
  };
});
vi.mock('node:fs/promises');
const mfs = mockFs();

describe.each([false, true])('consent lifecycle with execution contexts enabled: %s', (executionContexts) => {
  let consent: TrackingConsentManager;
  let histories: ContextHistoryFactory;
  let session: SessionManager;
  let collection: ViewCollection | ExecutionContextCollection;
  let hooks: FormatHooks;
  let events: RawRumEvent[];
  let eventContexts: unknown[];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    mfs.readFile.mockRejectedValue(new Error('ENOENT'));
    mfs.writeFile.mockResolvedValue(undefined);
    consent = new TrackingConsentManager();
    histories = new ContextHistoryFactory(consent, '/mock/user/data');
    hooks = createFormatHooks();
    events = [];
    eventContexts = [];
  });

  afterEach(() => {
    histories.stop();
    collection.stop();
    session.stop();
    mfs.reset();
    vi.useRealTimers();
  });

  async function start(initialConsent: TrackingConsent = 'granted') {
    consent.update(initialConsent);
    const eventManager = new EventManager();
    session = await SessionManager.start(eventManager, hooks, createTestConfiguration(), histories, consent);
    eventManager.registerHandler<RawRumEvent>({
      canHandle: (event): event is RawRumEvent => event.kind === EventKind.RAW && event.format === EventFormat.RUM,
      handle: (event) => {
        events.push(structuredClone(event));
        eventContexts.push(
          hooks.triggerRum({ eventType: event.data.type, startTime: event.startTime!, source: EventSource.MAIN })
        );
      },
    });
    collection = executionContexts
      ? await ExecutionContextCollection.start(eventManager, hooks, session, histories, consent)
      : await ViewCollection.start(eventManager, hooks, histories, consent);
  }

  function views(): RawRumView[] {
    return events.flatMap((event) => (event.data.type === 'view' ? [event.data] : []));
  }

  it('starts no collection while denied and creates one view when pending begins', async () => {
    await start('not-granted');
    vi.advanceTimersByTime(60_000);

    expect(events).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    expect(session.getTrackedSessionId()).toBeUndefined();

    consent.update('pending');

    expect(views()).toHaveLength(1);
    expect(views()[0].view.is_active).toBe(true);
    expect(session.getTrackedSessionId()).toBeDefined();
    expect(eventContexts).not.toContain(DISCARDED);
  });

  it('keeps view updates attributed to the active session across granted and pending', async () => {
    await start();
    const sessionId = session.getSession().id;
    vi.setSystemTime(1010);
    consent.update('pending');
    vi.setSystemTime(1020);
    consent.update('granted');

    expect(session.getSession().id).toBe(sessionId);
    expect(views()).toHaveLength(5);
    for (const context of eventContexts) {
      expect(context).toMatchObject({ session: { id: sessionId } });
    }
  });

  it('keeps terminal granted updates authorized when the following pending period is rejected', async () => {
    const grantedPost = vi.fn<(event: ServerEvent) => void>();
    const pendingPost = vi.fn<(event: ServerEvent) => void>();
    const eventManager = new EventManager();
    session = await SessionManager.start(eventManager, hooks, createTestConfiguration(), histories, consent);
    new MainAssembly(eventManager, hooks, new BeforeSend());
    // Match initialization order: transport observes consent before the collections emit their final updates.
    const router = await ConsentAwareBatchRouter.create(
      '/mock/rum',
      (directory) =>
        Promise.resolve({
          post: directory === '/mock/rum' ? grantedPost : pendingPost,
          flush: () => Promise.resolve(),
        } as unknown as BatchProducer),
      consent
    );
    eventManager.registerHandler<ServerEvent>({
      canHandle: (event): event is ServerEvent => event.kind === EventKind.SERVER,
      handle: (event) => router.post(event),
    });
    mfs.readdir.mockResolvedValue([]);

    try {
      collection = executionContexts
        ? await ExecutionContextCollection.start(eventManager, hooks, session, histories, consent)
        : await ViewCollection.start(eventManager, hooks, histories, consent);
      grantedPost.mockClear();

      vi.setSystemTime(1010);
      consent.update('pending');
      await router.flush();
      vi.setSystemTime(1020);
      consent.update('not-granted');
      await router.flush();

      const terminalUpdates = [
        {
          storageConsent: 'granted',
          data: { type: 'view', date: 1000, view: { is_active: false, time_spent: 10_000_000 } },
        },
      ];
      expect(grantedPost.mock.calls.map(([event]) => event)).toMatchObject(
        executionContexts
          ? [...terminalUpdates, { storageConsent: 'granted', data: { type: 'execution_context', date: 1000 } }]
          : terminalUpdates
      );
      expect(pendingPost).toHaveBeenCalledTimes(executionContexts ? 2 : 1);
    } finally {
      router.stop();
    }
  });

  it('does not persist a pending view created by synchronous session renewal', async () => {
    await start();
    vi.setSystemTime(1010);
    session.expire();
    await vi.advanceTimersByTimeAsync(0);
    mfs.writeFile.mockClear();

    vi.setSystemTime(1020);
    consent.update('pending');
    const pendingView = views()[2];
    expect(views()).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(0);
    expect(JSON.stringify(mfs.writeFile.mock.calls)).not.toContain(pendingView.view.id);

    vi.setSystemTime(1030);
    consent.update('not-granted');
    const eventCount = events.length;
    vi.advanceTimersByTime(60_000);
    expect(events).toHaveLength(eventCount);
    expect(hooks.triggerRum({ eventType: 'error', startTime: 1020 as TimeStamp, source: EventSource.MAIN })).toBe(
      DISCARDED
    );

    consent.update('granted');
    await vi.advanceTimersByTimeAsync(0);

    expect(views()).toHaveLength(5);
    const writes = mfs.writeFile.mock.calls.filter(([file]) => String(file).endsWith(VIEW_HISTORY_FILE_NAME));
    expect(String(writes[writes.length - 1][1])).not.toContain(pendingView.view.id);
    expect(views()[4].view.id).not.toBe(pendingView.view.id);
  });

  it('uses the transition timestamp for renewed session and view attribution despite an earlier slow observer', async () => {
    const subscription = consent.subscribe(() => vi.setSystemTime(Date.now() + 5));
    await start();
    vi.setSystemTime(1010);
    consent.update('not-granted');
    vi.setSystemTime(1020);
    consent.update('granted');

    const renewedView = views()[2];
    expect(renewedView.date).toBe(1020);
    expect(eventContexts[eventContexts.length - 1]).toMatchObject({
      session: { id: session.getSession().id },
      view: { id: renewedView.view.id },
    });
    subscription.unsubscribe();
  });
});
