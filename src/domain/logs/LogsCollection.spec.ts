import { runInNewContext } from 'node:vm';
import { display as browserDisplay, SANITIZE_DEFAULT_MAX_CHARACTER_COUNT } from '@datadog/browser-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { logger, setLogsApi } from '../../api';
import { BeforeSend, createFormatHooks, MainAssembly, registerCommonContext } from '../../assembly';
import { EventKind, EventManager, EventSource, EventTrack, type ServerLogsEvent } from '../../event';
import { createTestConfiguration } from '../../mocks.specUtil';
import { display } from '../../tools/display';
import { LOG_STATUSES, LogsCollection, type LogStatus } from './LogsCollection';
import { UserContext } from '../customer-context';

describe('main-process logger', () => {
  let events: ServerLogsEvent[];
  let eventManager: EventManager;
  let user: UserContext;
  let executionContext: { id: string; type: 'main-process'; name: string } | undefined;
  let sessionId: string | null;

  beforeEach(() => {
    events = [];
    executionContext = undefined;
    sessionId = null;
    eventManager = new EventManager();
    const hooks = createFormatHooks();
    user = new UserContext(hooks);
    user.setContext({ id: 'main-user' });
    const config = createTestConfiguration({ service: 'main-service', logsSampleRate: 100 });
    registerCommonContext(config, hooks);
    hooks.registerLogs(() => ({
      session_id: sessionId,
      session: { id: sessionId },
      execution_context: executionContext,
    }));
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

  it('snapshots customer attributes and lets them override ordinary log fields', () => {
    const nested = { value: 'original' };
    const context: Record<string, unknown> = {
      nested,
      date: 1,
      message: 'spoofed',
      status: 'error',
      service: 'other',
      version: '2.0.0',
      application_id: 'other',
      session_id: 'other',
      origin: 'other',
    };
    context.circular = context;
    logger.info('actual', context);
    nested.value = 'changed';
    expect(events[0].data).toMatchObject({
      nested: { value: 'original' },
      message: 'spoofed',
      status: 'error',
      service: 'other',
      version: '2.0.0',
      application_id: 'test-app-id',
      session_id: null,
      origin: 'other',
    });
    expect(events[0].data.date).toBe(1);
    expect(events[0].data.ddtags).toContain('service:other');
    expect(events[0].data.ddtags).toContain('version:2.0.0');
    expect(() => JSON.stringify(events[0].data)).not.toThrow();
  });

  it('applies logs sampling independently of RUM sampling', () => {
    setLogsApi(
      new LogsCollection(eventManager, createTestConfiguration({ logsSampleRate: 0, sessionSampleRate: 100 }))
    );
    logger.error('sampled out');
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

  it('preserves native cause stacks without forwarding error context or fingerprint', () => {
    const cause = new TypeError('root cause');
    const error = Object.assign(new Error('wrapper'), {
      cause,
      dd_fingerprint: 'custom-group',
      dd_context: { attempt: 1 },
    });
    logger.error('failed', { attempt: 2 }, error);
    expect(events[0].data).toMatchObject({
      attempt: 2,
      error: {
        stack: error.stack,
        handling: 'handled',
        causes: [{ message: 'root cause', type: 'TypeError', stack: cause.stack }],
      },
    });
    expect(events[0].data.error).not.toHaveProperty('fingerprint');
  });

  it('accepts runtime non-string messages, null context/errors, and typed interfaces', () => {
    const diagnostic = vi.spyOn(display, 'error').mockImplementation(() => undefined);
    interface Context {
      workspace: string;
    }
    const context: Context = { workspace: 'one' };
    logger.info('typed', context);
    logger.info(42 as unknown as string, null as unknown as object, null);
    expect(events.map(({ data }) => data.message)).toEqual(['typed', 42]);
    expect(events[0].data.workspace).toBe('one');
    expect(events[1].data.error).toBeUndefined();
    expect(diagnostic).not.toHaveBeenCalled();
  });

  it('reports and sends the log without an invalid context', () => {
    const diagnostic = vi.spyOn(display, 'error').mockImplementation(() => undefined);
    logger.error('invalid context', [{ unexpected: true }], new Error('failure'));
    expect(diagnostic).toHaveBeenCalledWith('logger: context must be an object. The context will be ignored.');
    expect(events[0].data).toMatchObject({ message: 'invalid context', error: { message: 'failure' } });
    expect(events[0].data).not.toHaveProperty('0');
  });

  it('snapshots caller context without merging error context', () => {
    const errorContext = { task: { id: 'sync', attempt: 1 }, errorOnly: true };
    const context = { task: { attempt: 2 } };
    const error = Object.assign(new Error('failed'), { dd_context: errorContext });
    logger.error('failed', context, error);
    expect(events[0].data.task).toEqual({ attempt: 2 });
    expect(events[0].data).not.toHaveProperty('errorOnly');
    expect(errorContext.task.attempt).toBe(1);
    context.task.attempt = 3;
    errorContext.task.id = 'changed';
    expect(events[0].data.task).toEqual({ attempt: 2 });
  });

  it('bounds message and context while preserving large error fields and SDK identity', () => {
    vi.spyOn(browserDisplay, 'warn').mockImplementation(() => undefined);
    const oversized = 'x'.repeat(SANITIZE_DEFAULT_MAX_CHARACTER_COUNT + 1);
    const cause = Object.assign(new TypeError('root cause'), { stack: oversized });
    const error = Object.assign(new Error(oversized), { stack: oversized, cause });
    logger.error(oversized, { task: 'sync', oversized }, error);
    expect(events[0].data).toMatchObject({
      message: '',
      status: 'error',
      task: 'sync',
      usr: { id: 'main-user' },
      service: 'main-service',
      application_id: 'test-app-id',
      error: {
        kind: 'Error',
        message: oversized,
        stack: oversized,
        source_type: 'nodejs',
        handling: 'handled',
        causes: [{ type: 'TypeError', message: 'root cause', source: 'logger', stack: oversized }],
      },
    });
    expect(events[0].data).not.toHaveProperty('oversized');
    expect(Buffer.byteLength(JSON.stringify(events[0].data), 'utf8')).toBeLessThan(1_000_000);
  });

  it('preserves the SDK execution context against custom log attributes', () => {
    executionContext = { id: 'main-context', type: 'main-process', name: 'Main Process' };
    logger.info('identity', { execution_context: { id: 'spoofed', extra: true } });
    expect(events[0].data.execution_context).toEqual(executionContext);
  });

  it.each([true, false])('preserves SDK correlation when session is tracked: %s', (tracked) => {
    sessionId = tracked ? 'sdk-session' : null;
    executionContext = tracked ? { id: 'sdk-context', type: 'main-process', name: 'Main Process' } : undefined;
    logger.info('identity', {
      application_id: 'other-app',
      session_id: 'other-session',
      session: { id: 'other-session', extra: true },
      execution_context: { id: 'other-context', extra: true },
    });
    expect(events[0].data.application_id).toBe('test-app-id');
    expect(events[0].data.session_id).toBe(sessionId);
    expect(events[0].data.session).toEqual({ id: sessionId });
    expect(events[0].data.execution_context).toEqual(executionContext);
  });

  it.each([true, false])('merges customer user context with SDK user set: %s', (hasUser) => {
    if (!hasUser) user.clearContext();
    logger.info('identity', { usr: { id: 'custom-user', role: 'admin' } });
    expect(events[0].data.usr).toEqual({ id: 'custom-user', role: 'admin' });
  });

  it('merges customer error fields with the supplied error', () => {
    const error = new Error('original');
    logger.error('failed', { error: { message: 'custom' } }, error);
    expect(events[0].data.error).toMatchObject({ kind: 'Error', message: 'custom', stack: error.stack });
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
