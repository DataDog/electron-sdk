import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RumVitalDurationEvent } from '../domain/rum';
import { createServerRumError, createServerRumResource, createServerRumView } from '../mocks.specUtil';
import { display } from '../tools/display';
import { BeforeSend } from './BeforeSend';

vi.mock('../tools/display', () => ({
  display: { error: vi.fn(), warn: vi.fn() },
}));

describe('BeforeSend', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns the event unchanged when beforeSend is not configured', () => {
    const event = createServerRumError();

    expect(new BeforeSend().apply(event)).toBe(event);
  });

  it('lets beforeSend modify supported fields on a fully assembled event', () => {
    const event = createServerRumError({
      service: 'original-service',
      context: { secret: 'token' },
      error: { message: 'secret message', stack: 'secret stack' },
    });
    const beforeSend = new BeforeSend((modifiableEvent) => {
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

    expect(beforeSend.apply(event)).toMatchObject({
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

    const result = beforeSend.apply(event);

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

    expect(beforeSend.apply(event)).toMatchObject({
      service: 'original-service',
      context: { secret: 'keep' },
      error: { message: 'original-message' },
    });
  });

  it('lets beforeSend modify resource URLs', () => {
    const beforeSend = new BeforeSend((event) => {
      if (event.type === 'resource') {
        event.resource.url = 'https://redacted.example';
      }
      return true;
    });

    expect(beforeSend.apply(createServerRumResource({ resource: { url: 'https://secret.example' } }))).toMatchObject({
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

    const viewResult = beforeSend.apply(view);
    const errorResult = beforeSend.apply(error);
    const resourceResult = beforeSend.apply(resource);

    expect(viewResult?.view.referrer).toBe('secret referrer');
    expect(errorResult?.error).toMatchObject({
      handling_stack: 'secret handling stack',
      fingerprint: 'secret fingerprint',
    });
    expect(resourceResult?.resource).toMatchObject({
      graphql: { variables: '{"secret":true}' },
      request: { headers: { authorization: 'secret' } },
    });
  });

  it('lets beforeSend modify context on main-process events', () => {
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

    expect(beforeSend.apply(view)?.context).toEqual({ scrubbed: true });
    expect(beforeSend.apply(resource)?.context).toEqual({ scrubbed: true });
    expect(beforeSend.apply(vital)?.context).toEqual({ scrubbed: true });
  });

  it('sanitizes context changes', () => {
    const beforeSend = new BeforeSend((event) => {
      const context: Record<string, unknown> = { secret: 'token' };
      context.circular = context;
      event.context = context;
      return true;
    });

    expect(beforeSend.apply(createServerRumError())?.context).toEqual({
      secret: 'token',
      circular: '[Reference seen at $]',
    });
  });

  it('removes an empty context after beforeSend', () => {
    const originalEvent = createServerRumError();
    const beforeSend = new BeforeSend((modifiableEvent) => {
      expect(originalEvent.context).toBeUndefined();
      expect(modifiableEvent.context).toEqual({});
      return true;
    });

    expect(beforeSend.apply(originalEvent)?.context).toBeUndefined();
  });

  it('removes context cleared by beforeSend', () => {
    const beforeSend = new BeforeSend((event) => {
      delete event.context;
      return true;
    });

    expect(beforeSend.apply(createServerRumError({ context: { secret: 'remove' } }))?.context).toBeUndefined();
  });

  it('drops an event only when beforeSend returns false', () => {
    expect(new BeforeSend(() => false).apply(createServerRumError())).toBeUndefined();
    expect(new BeforeSend(() => undefined as unknown as boolean).apply(createServerRumError())).toBeDefined();
  });

  it('does not drop view events', () => {
    const event = createServerRumView();

    expect(new BeforeSend(() => false).apply(event)).toBe(event);
    expect(display.warn).toHaveBeenCalledWith("Can't dismiss view events using beforeSend!");
  });

  it('does not drop crash events', () => {
    const event = createServerRumError({ error: { is_crash: true } });

    expect(new BeforeSend(() => false).apply(event)).toBe(event);
    expect(display.warn).toHaveBeenCalledWith("Can't dismiss crash events using beforeSend!");
  });

  it('fails open when beforeSend throws and keeps supported changes made before the error', () => {
    const event = createServerRumError();
    const beforeSend = new BeforeSend((modifiableEvent) => {
      if (modifiableEvent.type === 'error') {
        modifiableEvent.error.message = 'redacted before throw';
      }
      throw new Error('customer callback failed');
    });

    expect(beforeSend.apply(event)).toMatchObject({ error: { message: 'redacted before throw' } });
    expect(display.error).toHaveBeenCalledWith('beforeSend threw an error:', expect.any(Error));
  });
});
