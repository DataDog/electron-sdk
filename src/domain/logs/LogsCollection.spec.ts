import { runInNewContext } from 'node:vm';
import { display as browserDisplay, SANITIZE_DEFAULT_MAX_CHARACTER_COUNT } from '@datadog/browser-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { logger, setLogsApi } from '../../api';
import { BeforeSend, createFormatHooks, MainAssembly, registerCommonContext } from '../../assembly';
import { EventKind, EventManager, EventSource, EventTrack, type ServerLogsEvent } from '../../event';
import { createTestConfiguration } from '../../mocks.specUtil';
import { display } from '../../tools/display';
import { LOG_STATUSES, LogsCollection, type LogStatus } from './LogsCollection';

describe('main-process logger', () => {
  let events: ServerLogsEvent[];
  let eventManager: EventManager;
  let user: Record<string, unknown> | undefined;

  beforeEach(() => {
    events = [];
    user = { id: 'main-user' };
    eventManager = new EventManager();
    const hooks = createFormatHooks();
    const config = createTestConfiguration({ service: 'main-service', logsSampleRate: 100 });
    registerCommonContext(config, hooks);
    hooks.registerLogs(() => ({ session_id: null, session: { id: null }, usr: user }));
    new MainAssembly(eventManager, hooks, new BeforeSend());
    eventManager.registerHandler<ServerLogsEvent>({
      canHandle: (event): event is ServerLogsEvent =>
        event.kind === EventKind.SERVER && event.track === EventTrack.LOGS,
      handle: (event) => events.push(event),
    });
    setLogsApi(new LogsCollection(eventManager, config));
  });

  afterEach(() => {
    setLogsApi(undefined);
    vi.restoreAllMocks();
  });

  it.each(LOG_STATUSES)('sends %s logs with main-process identity without requiring a RUM session', (status) => {
    logger[status]('main log', { workspace: 'one' });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      source: EventSource.MAIN,
      data: {
        message: 'main log',
        status,
        origin: 'logger',
        service: 'main-service',
        workspace: 'one',
        application_id: 'test-app-id',
        session_id: null,
        session: { id: null },
        usr: { id: 'main-user' },
      },
    });
    expect(events[0].data.ddtags).toContain('service:main-service');
    expect(events[0].data.error).toBeUndefined();
  });

  it('formats an Error using the Browser logger argument order and the Node source type', () => {
    const error = new TypeError('cannot open workspace');
    logger.error('Opening failed', { attempt: 2 }, error);
    expect(events[0].data).toMatchObject({
      message: 'Opening failed',
      status: 'error',
      attempt: 2,
      error: { kind: 'TypeError', message: error.message, stack: error.stack, source_type: 'nodejs' },
    });
  });

  it('supports explicit and default levels on log()', () => {
    logger.log('default');
    logger.log('explicit', undefined, 'warn');
    expect(events.map(({ data }) => data.status)).toEqual(['info', 'warn']);
  });

  it('snapshots and sanitizes custom attributes while preserving identity and log fields', () => {
    const nested = { value: 'original' };
    const context: Record<string, unknown> = {
      nested,
      date: 1,
      message: 'spoofed',
      status: 'error',
      service: 'other',
      application_id: 'other',
      session_id: 'other',
      origin: 'other',
    };
    context.circular = context;
    logger.info('actual', context);
    nested.value = 'changed';
    expect(events[0].data).toMatchObject({
      nested: { value: 'original' },
      message: 'actual',
      status: 'info',
      service: 'main-service',
      application_id: 'test-app-id',
      session_id: null,
      origin: 'logger',
    });
    expect(events[0].data.date).not.toBe(1);
    expect(() => JSON.stringify(events[0].data)).not.toThrow();
  });

  it('applies logs sampling independently of RUM sampling', () => {
    setLogsApi(
      new LogsCollection(eventManager, createTestConfiguration({ logsSampleRate: 0, sessionSampleRate: 100 }))
    );
    for (let i = 0; i < 3_002; i++) logger.error('sampled out');
    expect(events).toEqual([]);
    setLogsApi(
      new LogsCollection(eventManager, createTestConfiguration({ logsSampleRate: 100, sessionSampleRate: 0 }))
    );
    logger.info('sampled in');
    expect(events).toHaveLength(1);
  });

  it('rejects an invalid status without throwing into the application', () => {
    const warning = vi.spyOn(display, 'error').mockImplementation(() => undefined);
    expect(() => logger.log('bad status', undefined, 'invalid' as LogStatus)).not.toThrow();
    expect(events).toEqual([]);
    expect(warning).toHaveBeenCalledOnce();
  });

  it.each(['thrown string', { reason: 'failure' }, runInNewContext('new Error("other context")') as Error])(
    'retains the log and formats a non-local error: %s',
    (error) => {
      logger.error('original message', undefined, error);
      expect(events[0].data).toMatchObject({
        message: 'original message',
        error: { handling: 'handled', source_type: 'nodejs' },
      });
      expect(events[0].data.error).toHaveProperty('message', expect.any(String));
      if (typeof error === 'object' && 'stack' in error) {
        expect(events[0].data.error).toHaveProperty('stack', error.stack);
      }
    }
  );

  it('preserves native cause stacks, fingerprint, and error context', () => {
    const cause = new TypeError('root cause');
    const error = Object.assign(new Error('wrapper'), {
      cause,
      dd_fingerprint: 'custom-group',
      dd_context: { attempt: 1 },
    });
    logger.error('failed', undefined, error);
    expect(events[0].data).toMatchObject({
      attempt: 1,
      error: {
        stack: error.stack,
        fingerprint: 'custom-group',
        handling: 'handled',
        causes: [{ message: 'root cause', type: 'TypeError', stack: cause.stack }],
      },
    });
  });

  it('accepts runtime non-string messages, null context/errors, and typed interfaces', () => {
    interface Context {
      workspace: string;
    }
    const context: Context = { workspace: 'one' };
    logger.info('typed', context);
    logger.info(42 as unknown as string, null as unknown as object, null);
    expect(events.map(({ data }) => data.message)).toEqual(['typed', 42]);
    expect(events[0].data.workspace).toBe('one');
    expect(events[1].data.error).toBeUndefined();
  });

  it('merges nested error and caller context without mutating either', () => {
    const errorContext = { task: { id: 'sync', attempt: 1 } };
    const context = { task: { attempt: 2 } };
    const error = Object.assign(new Error('failed'), { dd_context: errorContext });
    logger.error('failed', context, error);
    expect(events[0].data.task).toEqual({ id: 'sync', attempt: 2 });
    expect(errorContext.task.attempt).toBe(1);
    context.task.attempt = 3;
    errorContext.task.id = 'changed';
    expect(events[0].data.task).toEqual({ id: 'sync', attempt: 2 });
  });

  it('bounds message, context and error independently without losing SDK identity', () => {
    vi.spyOn(browserDisplay, 'warn').mockImplementation(() => undefined);
    const oversized = 'x'.repeat(SANITIZE_DEFAULT_MAX_CHARACTER_COUNT + 1);
    const error = Object.assign(new Error('failed'), { stack: oversized });
    logger.error(oversized, { task: 'sync', oversized }, error);
    expect(events[0].data).toMatchObject({
      message: '',
      status: 'error',
      task: 'sync',
      usr: { id: 'main-user' },
      service: 'main-service',
      application_id: 'test-app-id',
      error: { kind: 'Error', message: 'failed', source_type: 'nodejs' },
    });
    expect(events[0].data).not.toHaveProperty('oversized');
    expect(events[0].data.error).not.toHaveProperty('stack');
    expect(JSON.stringify(events[0].data).length).toBeLessThan(SANITIZE_DEFAULT_MAX_CHARACTER_COUNT);
  });

  it.each([true, false])('reserves SDK identity objects with user set: %s', (hasUser) => {
    if (!hasUser) user = undefined;
    logger.info('identity', {
      usr: { id: 'spoofed', name: 'extra' },
      account: { id: 'spoofed' },
      view: { id: 'spoofed' },
      session: { id: 'spoofed', extra: true },
      ddsource: 'browser',
    });
    expect(events[0].data.usr).toEqual(user);
    expect(events[0].data.account).toBeUndefined();
    expect(events[0].data.view).toBeUndefined();
    expect(events[0].data.session).toEqual({ id: null });
    expect(events[0].data.ddsource).toBeUndefined();
  });

  it('reports each exceeded status once, bypasses the error budget, and resets after a minute', () => {
    vi.useFakeTimers({ toFake: ['performance'] });
    const warning = vi.spyOn(display, 'warn').mockImplementation(() => undefined);
    const notices = () => events.filter(({ data }) => data.origin === 'agent');
    try {
      for (const status of ['error', 'info'] as const) {
        for (let i = 0; i < 3_002; i++) logger[status]('loop');
      }
      expect(events.filter(({ data }) => data.origin === 'logger')).toHaveLength(6_000);
      expect(notices()).toMatchObject([
        {
          source: EventSource.MAIN,
          data: {
            status: 'error',
            service: 'main-service',
            application_id: 'test-app-id',
            usr: { id: 'main-user' },
          },
        },
        { data: { status: 'error' } },
      ]);
      expect(notices()[0].data.message).toContain('3000 error logs per minute');
      expect(notices()[1].data.message).toContain('3000 info logs per minute');
      expect(notices().every(({ data }) => data.error === undefined)).toBe(true);
      expect(warning).toHaveBeenCalledTimes(2);
      vi.advanceTimersByTime(60_000);
      logger.error('next window');
      expect(events[events.length - 1].data.message).toBe('next window');
      for (let i = 0; i < 3_001; i++) logger.error('loop');
      expect(notices()).toHaveLength(3);
      expect(warning).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('warns once and does not send logs before initialization', () => {
    const warning = vi.spyOn(display, 'warn').mockImplementation(() => undefined);
    setLogsApi(undefined);
    logger.info('before init');
    logger.info('still before init');
    expect(events).toEqual([]);
    expect(warning).toHaveBeenCalledOnce();
  });
});
