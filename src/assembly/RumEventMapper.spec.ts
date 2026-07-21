import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RumEvent, RumLongTaskEvent, RumViewUpdateEvent } from '../domain/rum';
import {
  createServerRumAction,
  createServerRumError,
  createServerRumResource,
  createServerRumView,
} from '../mocks.specUtil';
import { display } from '../tools/display';
import { RumEventMapper } from './RumEventMapper';

vi.mock('../tools/display', () => ({
  display: { error: vi.fn(), warn: vi.fn() },
}));

describe('RumEventMapper', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns the event unchanged when beforeSend is not configured', () => {
    const event = createServerRumError();

    expect(new RumEventMapper().map(event)).toBe(event);
  });

  it('lets beforeSend modify supported fields on a fully assembled event', () => {
    const event = createServerRumError({
      service: 'original-service',
      context: { secret: 'token' },
      error: { message: 'secret message', stack: 'secret stack' },
    });
    const mapper = new RumEventMapper((modifiableEvent) => {
      expect(modifiableEvent.session.id).toBe('2');
      if (modifiableEvent.type === 'error') {
        modifiableEvent.service = 'mapped-service';
        modifiableEvent.view.name = 'mapped-view';
        modifiableEvent.context = { scrubbed: true };
        modifiableEvent.error.message = 'redacted';
        modifiableEvent.error.stack = 'redacted';
      }
      return true;
    });

    expect(mapper.map(event)).toMatchObject({
      service: 'mapped-service',
      view: { name: 'mapped-view' },
      context: { scrubbed: true },
      error: { message: 'redacted', stack: 'redacted' },
    });
  });

  it('ignores modifications to protected fields', () => {
    const event = createServerRumError();
    const originalDate = event.date;
    const mapper = new RumEventMapper((modifiableEvent) => {
      if (modifiableEvent.type === 'error') {
        Object.assign(modifiableEvent, { type: 'view', date: 42 });
        Object.assign(modifiableEvent.session, { id: 'changed-session' });
        Object.assign(modifiableEvent.error, { source: 'network' });
      }
      return true;
    });

    const mappedEvent = mapper.map(event);

    expect(mappedEvent?.type).toBe('error');
    expect(mappedEvent?.date).toBe(originalDate);
    expect(mappedEvent?.session.id).toBe('2');
    expect(mappedEvent).toMatchObject({ error: { source: 'source' } });
  });

  it('ignores wrong-type modifications to allowlisted fields', () => {
    const event = createServerRumError({
      service: 'original-service',
      context: { secret: 'keep' },
      error: { message: 'original-message' },
    });
    const mapper = new RumEventMapper((modifiableEvent) => {
      Object.assign(modifiableEvent, { service: 42, context: ['invalid'] });
      if (modifiableEvent.type === 'error') {
        Object.assign(modifiableEvent.error, { message: { invalid: true } });
      }
      return true;
    });

    expect(mapper.map(event)).toMatchObject({
      service: 'original-service',
      context: { secret: 'keep' },
      error: { message: 'original-message' },
    });
  });

  it('supports event-specific modifiable fields', () => {
    const mapper = new RumEventMapper((event) => {
      if (event.type === 'view' && event.view.performance?.lcp) {
        event.view.performance.lcp.resource_url = 'redacted.png';
      } else if (event.type === 'error') {
        event.error.message = 'redacted message';
        event.error.stack = 'redacted stack';
        event.error.handling_stack = 'redacted handling stack';
        if (event.error.resource) {
          event.error.resource.url = 'https://redacted.example/error';
        }
        event.error.fingerprint = 'redacted fingerprint';
        if (event._dd?.debug_ids) {
          event._dd.debug_ids[0].url = 'redacted-error.js';
        }
      } else if (event.type === 'resource') {
        event.resource.url = 'https://redacted.example';
        if (event.resource.graphql) {
          event.resource.graphql.variables = '{"redacted":true}';
        }
        if (event.resource.request?.headers) {
          event.resource.request.headers.authorization = '[REDACTED]';
        }
        if (event.resource.response?.headers) {
          event.resource.response.headers['set-cookie'] = '[REDACTED]';
        }
        const websocket = event.resource.websocket as { close_reason?: string } | undefined;
        if (websocket) {
          websocket.close_reason = 'redacted reason';
        }
      } else if (event.type === 'action' && event.action.target) {
        event.action.target.name = 'redacted target';
      } else if (event.type === 'long_task' && event.long_task.scripts) {
        event.long_task.scripts[0].source_url = 'redacted.js';
        event.long_task.scripts[0].invoker = 'redacted invoker';
        if (event._dd?.debug_ids) {
          event._dd.debug_ids[0].url = 'redacted-long-task.js';
        }
      }
      return true;
    });
    const view = createServerRumView({
      view: { performance: { lcp: { resource_url: 'secret.png' } } },
    });
    const error = createServerRumError({
      error: {
        message: 'secret message',
        stack: 'secret stack',
        handling_stack: 'secret handling stack',
        resource: { url: 'https://secret.example/error' },
        fingerprint: 'secret fingerprint',
      },
      _dd: { debug_ids: [{ url: 'secret-error.js', id: 'error-debug-id' }] },
    });
    const resource = createServerRumResource({
      resource: {
        graphql: { variables: '{"secret":true}' },
        request: { headers: { authorization: 'secret' } },
        response: { headers: { 'set-cookie': 'secret' } },
      },
    });
    Object.assign(resource.resource, { websocket: { close_reason: 'secret reason' } });
    const action = createServerRumAction({ action: { target: { name: 'secret target' } } });
    const longTask: RumLongTaskEvent = {
      type: 'long_task',
      date: 1,
      application: { id: 'app-id' },
      session: { id: 'session-id', type: 'user' },
      view: { id: 'view-id', url: 'app://index' },
      _dd: { format_version: 2, debug_ids: [{ url: 'secret-long-task.js', id: 'long-task-debug-id' }] },
      long_task: {
        duration: 1,
        scripts: [{ source_url: 'secret.js', invoker: 'secret invoker' }],
      },
    };

    expect(mapper.map(view)).toMatchObject({
      view: { performance: { lcp: { resource_url: 'redacted.png' } } },
    });
    expect(mapper.map(error)).toMatchObject({
      error: {
        message: 'redacted message',
        stack: 'redacted stack',
        handling_stack: 'redacted handling stack',
        resource: { url: 'https://redacted.example/error' },
        fingerprint: 'redacted fingerprint',
      },
      _dd: { debug_ids: [{ url: 'redacted-error.js', id: 'error-debug-id' }] },
    });
    expect(mapper.map(resource)).toMatchObject({
      resource: {
        url: 'https://redacted.example',
        graphql: { variables: '{"redacted":true}' },
        request: { headers: { authorization: '[REDACTED]' } },
        response: { headers: { 'set-cookie': '[REDACTED]' } },
        websocket: { close_reason: 'redacted reason' },
      },
    });
    expect(mapper.map(action)).toMatchObject({ action: { target: { name: 'redacted target' } } });
    expect(mapper.map(longTask)).toMatchObject({
      long_task: { scripts: [{ source_url: 'redacted.js', invoker: 'redacted invoker' }] },
      _dd: { debug_ids: [{ url: 'redacted-long-task.js', id: 'long-task-debug-id' }] },
    });
  });

  it('sanitizes context changes', () => {
    const mapper = new RumEventMapper((event) => {
      const context: Record<string, unknown> = { secret: 'token' };
      context.circular = context;
      event.context = context;
      return true;
    });

    expect(mapper.map(createServerRumError())?.context).toEqual({
      secret: 'token',
      circular: '[Reference seen at $]',
    });
  });

  it('removes an empty context after beforeSend', () => {
    const originalEvent = createServerRumError();
    const mapper = new RumEventMapper((modifiableEvent) => {
      expect(originalEvent.context).toBeUndefined();
      expect(modifiableEvent.context).toEqual({});
      return true;
    });

    expect(mapper.map(originalEvent)?.context).toBeUndefined();
  });

  it('removes context cleared by beforeSend', () => {
    const mapper = new RumEventMapper((event) => {
      delete event.context;
      return true;
    });

    expect(mapper.map(createServerRumError({ context: { secret: 'remove' } }))?.context).toBeUndefined();
  });

  it('drops an event only when beforeSend returns false', () => {
    expect(new RumEventMapper(() => false).map(createServerRumError())).toBeUndefined();
    expect(new RumEventMapper(() => undefined as unknown as boolean).map(createServerRumError())).toBeDefined();
  });

  it('does not drop view events', () => {
    const event = createServerRumView();

    expect(new RumEventMapper(() => false).map(event)).toBe(event);
    expect(display.warn).toHaveBeenCalledWith("Can't dismiss view events using beforeSend!");
  });

  it('does not drop crash events', () => {
    const event = createServerRumError({ error: { is_crash: true } });

    expect(new RumEventMapper(() => false).map(event)).toBe(event);
    expect(display.warn).toHaveBeenCalledWith("Can't dismiss crash events using beforeSend!");
  });

  it('fails open when beforeSend throws and keeps supported changes made before the error', () => {
    const event = createServerRumError();
    const mapper = new RumEventMapper((modifiableEvent) => {
      if (modifiableEvent.type === 'error') {
        modifiableEvent.error.message = 'redacted before throw';
      }
      throw new Error('customer callback failed');
    });

    expect(mapper.map(event)).toMatchObject({ error: { message: 'redacted before throw' } });
    expect(display.error).toHaveBeenCalledWith('beforeSend threw an error:', expect.any(Error));
  });

  it('invokes beforeSend without binding a this value', () => {
    const beforeSend = vi.fn(function (_event: RumEvent) {
      return true;
    });

    new RumEventMapper(beforeSend).map(createServerRumError());

    expect(beforeSend.mock.contexts[0]).toBeUndefined();
  });

  it('does not expose internal view updates to beforeSend', () => {
    const beforeSend = vi.fn(() => false);
    const event = { ...createServerRumView(), type: 'view_update' } as RumViewUpdateEvent;

    expect(new RumEventMapper(beforeSend).map(event as RumEvent)).toBe(event);
    expect(beforeSend).not.toHaveBeenCalled();
  });
});
