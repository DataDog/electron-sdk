import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RumLongTaskEvent, RumVitalDurationEvent } from '../domain/rum';
import {
  createServerRumAction,
  createServerRumError,
  createServerRumResource,
  createServerRumView,
} from '../mocks.specUtil';
import { display } from '../tools/display';
import { BeforeSend } from './BeforeSend';

vi.mock('../tools/display', () => ({
  display: { error: vi.fn(), warn: vi.fn() },
}));

describe('beforeSendRum', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns the event unchanged when beforeSendRum is not configured', () => {
    const event = createServerRumError();

    expect(new BeforeSend().apply(event, 'main')).toBe(event);
  });

  it('lets beforeSendRum modify supported fields on a fully assembled event', () => {
    const event = createServerRumError({
      service: 'original-service',
      context: { secret: 'token' },
      error: { message: 'secret message', stack: 'secret stack' },
    });
    const beforeSend = new BeforeSend((modifiableEvent, context) => {
      expect(context).toEqual({ source: 'main' });
      expect(modifiableEvent.session.id).toBe('2');
      if (modifiableEvent.type === 'error') {
        modifiableEvent.service = 'modified-service';
        modifiableEvent.view.name = 'modified-view';
        modifiableEvent.context = { scrubbed: true };
        modifiableEvent.error.message = 'redacted';
        modifiableEvent.error.stack = 'redacted';
      }
      return true;
    });

    expect(beforeSend.apply(event, 'main')).toMatchObject({
      service: 'modified-service',
      view: { name: 'modified-view' },
      context: { scrubbed: true },
      error: { message: 'redacted', stack: 'redacted' },
    });
  });

  it('ignores modifications to protected fields', () => {
    const event = createServerRumError();
    const originalDate = event.date;
    const beforeSend = new BeforeSend((modifiableEvent) => {
      if (modifiableEvent.type === 'error') {
        Object.assign(modifiableEvent, { type: 'view', date: 42 });
        Object.assign(modifiableEvent.session, { id: 'changed-session' });
        Object.assign(modifiableEvent.error, { source: 'network' });
      }
      return true;
    });

    const result = beforeSend.apply(event, 'main');

    expect(result?.type).toBe('error');
    expect(result?.date).toBe(originalDate);
    expect(result?.session.id).toBe('2');
    expect(result).toMatchObject({ error: { source: 'source' } });
  });

  it('ignores wrong-type modifications to allowlisted fields', () => {
    const event = createServerRumError({
      service: 'original-service',
      context: { secret: 'keep' },
      error: { message: 'original-message' },
    });
    const beforeSend = new BeforeSend((modifiableEvent) => {
      Object.assign(modifiableEvent, { service: 42, context: ['invalid'] });
      if (modifiableEvent.type === 'error') {
        Object.assign(modifiableEvent.error, { message: { invalid: true } });
      }
      return true;
    });

    expect(beforeSend.apply(event, 'main')).toMatchObject({
      service: 'original-service',
      context: { secret: 'keep' },
      error: { message: 'original-message' },
    });
  });

  it('lets beforeSendRum modify resource URLs', () => {
    const beforeSend = new BeforeSend((event) => {
      if (event.type === 'resource') {
        event.resource.url = 'https://redacted.example';
      }
      return true;
    });

    expect(
      beforeSend.apply(createServerRumResource({ resource: { url: 'https://secret.example' } }), 'main')
    ).toMatchObject({
      resource: { url: 'https://redacted.example' },
    });
  });

  it('lets beforeSendRum modify renderer-specific fields', () => {
    const view = createServerRumView({ view: { referrer: 'secret referrer' } });
    const error = createServerRumError({
      error: { handling_stack: 'secret handling stack', fingerprint: 'secret fingerprint' },
    });
    const resource = createServerRumResource({
      resource: {
        graphql: { variables: '{"secret":true}' },
        request: { headers: { authorization: 'secret' } },
      },
    });
    const beforeSend = new BeforeSend((event) => {
      event.view.referrer = 'redacted referrer';
      if (event.type === 'error') {
        event.error.handling_stack = 'redacted handling stack';
        event.error.fingerprint = 'redacted fingerprint';
      } else if (event.type === 'resource') {
        if (event.resource.graphql) {
          event.resource.graphql.variables = '{"redacted":true}';
        }
        if (event.resource.request?.headers) {
          event.resource.request.headers.authorization = '[REDACTED]';
        }
      }
      return true;
    });

    const viewResult = beforeSend.apply(view, 'renderer');
    const errorResult = beforeSend.apply(error, 'renderer');
    const resourceResult = beforeSend.apply(resource, 'renderer');

    expect(viewResult?.view.referrer).toBe('redacted referrer');
    expect(errorResult?.error).toMatchObject({
      handling_stack: 'redacted handling stack',
      fingerprint: 'redacted fingerprint',
    });
    expect(resourceResult?.resource).toMatchObject({
      graphql: { variables: '{"redacted":true}' },
      request: { headers: { authorization: '[REDACTED]' } },
    });
  });

  it('lets beforeSendRum modify action targets and long task scripts', () => {
    const action = createServerRumAction({ action: { target: { name: 'secret target' } } });
    const longTask = {
      type: 'long_task',
      date: 1,
      application: { id: 'app-id' },
      session: { id: 'session-id', type: 'user' },
      view: { id: 'view-id' },
      long_task: { duration: 1, scripts: [{ source_url: 'secret.js', invoker: 'secret invoker' }] },
    } as RumLongTaskEvent;
    const beforeSend = new BeforeSend((event) => {
      if (event.type === 'action' && event.action.target) {
        event.action.target.name = 'redacted target';
      }
      if (event.type === 'long_task' && event.long_task.scripts) {
        event.long_task.scripts[0].source_url = 'redacted.js';
        event.long_task.scripts[0].invoker = 'redacted invoker';
      }
      return true;
    });

    expect(beforeSend.apply(action, 'renderer')?.action.target?.name).toBe('redacted target');
    expect(beforeSend.apply(longTask, 'renderer')?.long_task.scripts?.[0]).toMatchObject({
      source_url: 'redacted.js',
      invoker: 'redacted invoker',
    });
  });

  it('lets beforeSendRum modify context on main-process events', () => {
    const view = createServerRumView();
    const resource = createServerRumResource();
    const vital = {
      type: 'vital',
      date: 1,
      application: { id: 'app-id' },
      session: { id: 'session-id', type: 'user' },
      view: { id: 'view-id', name: 'main process', url: 'electron://main-process' },
      vital: { id: 'vital-id', name: 'startup', type: 'duration', duration: 1 },
    } as RumVitalDurationEvent;
    const beforeSend = new BeforeSend((event) => {
      event.context = { scrubbed: true };
      return true;
    });

    expect(beforeSend.apply(view, 'main')?.context).toEqual({ scrubbed: true });
    expect(beforeSend.apply(resource, 'main')?.context).toEqual({ scrubbed: true });
    expect(beforeSend.apply(vital, 'main')?.context).toEqual({ scrubbed: true });
  });

  it('sanitizes context changes', () => {
    const beforeSend = new BeforeSend((event) => {
      const context: Record<string, unknown> = { secret: 'token' };
      context.circular = context;
      event.context = context;
      return true;
    });

    expect(beforeSend.apply(createServerRumError(), 'main')?.context).toEqual({
      secret: 'token',
      circular: '[Reference seen at $]',
    });
  });

  it('removes an empty context after beforeSendRum', () => {
    const originalEvent = createServerRumError();
    const beforeSend = new BeforeSend((modifiableEvent) => {
      expect(originalEvent.context).toBeUndefined();
      expect(modifiableEvent.context).toEqual({});
      return true;
    });

    expect(beforeSend.apply(originalEvent, 'main')?.context).toBeUndefined();
  });

  it('removes context cleared by beforeSendRum', () => {
    const beforeSend = new BeforeSend((event) => {
      delete event.context;
      return true;
    });

    expect(beforeSend.apply(createServerRumError({ context: { secret: 'remove' } }), 'main')?.context).toBeUndefined();
  });

  it('drops an event only when beforeSendRum returns false', () => {
    expect(new BeforeSend(() => false).apply(createServerRumError(), 'main')).toBeUndefined();
    expect(new BeforeSend(() => undefined as unknown as boolean).apply(createServerRumError(), 'main')).toBeDefined();
  });

  it('does not drop view events', () => {
    const event = createServerRumView();

    expect(new BeforeSend(() => false).apply(event, 'main')).toBe(event);
    expect(display.warn).toHaveBeenCalledWith("Can't dismiss view events using beforeSendRum!");
  });

  it('does not drop crash events', () => {
    const event = createServerRumError({ error: { is_crash: true } });

    expect(new BeforeSend(() => false).apply(event, 'main')).toBe(event);
    expect(display.warn).toHaveBeenCalledWith("Can't dismiss crash events using beforeSendRum!");
  });

  it('fails open when beforeSendRum throws and keeps supported changes made before the error', () => {
    const event = createServerRumError();
    const beforeSend = new BeforeSend((modifiableEvent) => {
      if (modifiableEvent.type === 'error') {
        modifiableEvent.error.message = 'redacted before throw';
      }
      throw new Error('customer callback failed');
    });

    expect(beforeSend.apply(event, 'main')).toMatchObject({ error: { message: 'redacted before throw' } });
    expect(display.error).toHaveBeenCalledWith('beforeSendRum threw an error:', expect.any(Error));
  });
});
