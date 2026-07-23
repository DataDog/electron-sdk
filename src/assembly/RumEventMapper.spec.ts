import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MainRumEvent, RumVitalDurationEvent } from '../domain/rum';
import { createServerRumError, createServerRumResource, createServerRumView } from '../mocks.specUtil';
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
      if (event.type === 'error') {
        event.error.message = 'redacted message';
        event.error.stack = 'redacted stack';
      } else if (event.type === 'resource') {
        event.resource.url = 'https://redacted.example';
      }
      return true;
    });

    expect(
      mapper.map(createServerRumError({ error: { message: 'secret message', stack: 'secret stack' } }))
    ).toMatchObject({
      error: { message: 'redacted message', stack: 'redacted stack' },
    });
    expect(mapper.map(createServerRumResource({ resource: { url: 'https://secret.example' } }))).toMatchObject({
      resource: { url: 'https://redacted.example' },
    });
  });

  it('ignores modifications to fields that are only produced by renderer events', () => {
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
    const mapper = new RumEventMapper((event) => {
      event.view.referrer = 'redacted referrer';
      event.context = { scrubbed: true };
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

    expect(mapper.map(view)?.view.referrer).toBe('secret referrer');
    expect(mapper.map(view)?.context).toBeUndefined();
    expect(mapper.map(error)?.error).toMatchObject({
      handling_stack: 'secret handling stack',
      fingerprint: 'secret fingerprint',
    });
    expect(mapper.map(resource)?.resource).toMatchObject({
      graphql: { variables: '{"secret":true}' },
      request: { headers: { authorization: 'secret' } },
    });
    expect(mapper.map(resource)?.context).toBeUndefined();
  });

  it('lets beforeSend modify context on main-process vital events', () => {
    const vital = {
      type: 'vital',
      date: 1,
      application: { id: 'app-id' },
      session: { id: 'session-id', type: 'user' },
      view: { id: 'view-id', name: 'main process', url: 'electron://main-process' },
      vital: { id: 'vital-id', name: 'startup', type: 'duration', duration: 1 },
    } as RumVitalDurationEvent;
    const mapper = new RumEventMapper((event) => {
      event.context = { scrubbed: true };
      return true;
    });

    expect(mapper.map(vital)?.context).toEqual({ scrubbed: true });
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
    const beforeSend = vi.fn(function (_event: MainRumEvent) {
      return true;
    });

    new RumEventMapper(beforeSend).map(createServerRumError());

    expect(beforeSend.mock.contexts[0]).toBeUndefined();
  });
});
