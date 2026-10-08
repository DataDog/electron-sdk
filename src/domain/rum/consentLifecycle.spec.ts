import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DISCARDED } from '@datadog/js-core/assembly';
import type { TimeStamp } from '@datadog/js-core/time';
import { BeforeSend, createFormatHooks, MainAssembly, type FormatHooks } from '../../assembly';
import {
  EventFormat,
  EventKind,
  EventManager,
  EventSource,
  LifecycleKind,
  type RawRumEvent,
  type ServerEvent,
} from '../../event';
import { createTestConfiguration, mockFs } from '../../mocks.specUtil';
import { ConsentAwareBatchRouter, type BatchProducer } from '../../transport/batch';
import { SessionManager } from '../session';
import { TrackingConsentManager, type TrackingConsent } from '../tracking-consent';
import { ExecutionContextCollection } from './executionContext';
import { ViewCollection } from './view';
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
  let eventManager: EventManager;
  let session: SessionManager;
  let collection: ViewCollection | ExecutionContextCollection;
  let hooks: FormatHooks;
  let events: RawRumEvent[];
  let router: ConsentAwareBatchRouter;
  const grantedPost = vi.fn<(event: ServerEvent) => void>();
  const pendingPost = vi.fn<(event: ServerEvent) => void>();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    mfs.readFile.mockRejectedValue(new Error('ENOENT'));
    mfs.writeFile.mockResolvedValue(undefined);
    mfs.readdir.mockResolvedValue([]);
    consent = new TrackingConsentManager();
    hooks = createFormatHooks();
    events = [];
    grantedPost.mockClear();
    pendingPost.mockClear();
  });

  afterEach(() => {
    router.stop();
    collection.stop();
    session.stop();
    mfs.reset();
    vi.useRealTimers();
  });

  // Same order as SDK initialization: storage subscribes to consent before the session manager.
  async function start(initialConsent: TrackingConsent = 'granted') {
    consent.update(initialConsent);
    eventManager = new EventManager();
    router = await ConsentAwareBatchRouter.create(
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
    session = await SessionManager.start(eventManager, hooks, createTestConfiguration(), consent);
    new MainAssembly(eventManager, hooks, new BeforeSend());
    eventManager.registerHandler<RawRumEvent>({
      canHandle: (event): event is RawRumEvent => event.kind === EventKind.RAW && event.format === EventFormat.RUM,
      handle: (event) => events.push(structuredClone(event)),
    });
    collection = executionContexts
      ? await ExecutionContextCollection.start(eventManager, hooks, session)
      : await ViewCollection.start(eventManager, hooks, session);
  }

  function views(): RawRumView[] {
    return events.flatMap((event) => (event.data.type === 'view' ? [event.data] : []));
  }

  function openingDocuments() {
    return [
      { type: 'view', session: { id: session.getSession().id }, _dd: { document_version: 1 } },
      ...(executionContexts ? [{ type: 'execution_context', _dd: { document_version: 1 } }] : []),
    ];
  }

  it('starts nothing while refused and stores the opening documents when tracking resumes into pending', async () => {
    await start('not-granted');
    vi.advanceTimersByTime(60_000);

    expect(events).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    expect(session.getTrackedSessionId()).toBeUndefined();

    consent.update('pending');
    await router.flush();

    expect(grantedPost).not.toHaveBeenCalled();
    expect(pendingPost.mock.calls.map(([event]) => event.data)).toMatchObject(openingDocuments());
  });

  it('keeps the session and its documents when consent moves between granted and pending', async () => {
    await start();
    const sessionId = session.getSession().id;
    const eventCount = events.length;

    consent.update('pending');
    consent.update('granted');

    expect(session.getSession().id).toBe(sessionId);
    expect(events).toHaveLength(eventCount);
  });

  it.each<TrackingConsent>(['granted', 'pending'])(
    'ends tracking on refusal and resumes with new documents when consent becomes %s',
    async (resumedConsent) => {
      await start();
      const firstView = views()[0].view;
      grantedPost.mockClear();

      vi.setSystemTime(1010);
      consent.update('not-granted');
      vi.advanceTimersByTime(60_000);
      eventManager.notify({ kind: EventKind.LIFECYCLE, lifecycle: LifecycleKind.END_USER_ACTIVITY });
      await router.flush();

      expect(views()[views().length - 1].view).toMatchObject({ id: firstView.id, is_active: false });
      expect(vi.getTimerCount()).toBe(0);
      expect(grantedPost).not.toHaveBeenCalled();
      expect(hooks.triggerRum({ eventType: 'error', startTime: 1020 as TimeStamp, source: EventSource.MAIN })).toBe(
        DISCARDED
      );

      vi.setSystemTime(1030);
      consent.update(resumedConsent);
      await router.flush();

      const resumedPost = resumedConsent === 'granted' ? grantedPost : pendingPost;
      expect(resumedPost.mock.calls.map(([event]) => event.data)).toMatchObject(openingDocuments());
      expect(views()[views().length - 1].view.id).not.toBe(firstView.id);
    }
  );
});
