import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as DiagnosticsChannel from 'node:diagnostics_channel';
import { DISCARDED, SKIPPED } from '@datadog/browser-core';
import { EventFormat, EventKind, EventManager, EventSource, EventTrack } from '../../event';
import type { Event, RawRumEvent, ServerSpansEvent } from '../../event';
import { createFormatHooks, type FormatHooks } from '../../assembly';
import type { Configuration } from '../../config';
import { ExportedSpan, SpanProcessor } from './SpanProcessor';

vi.mock('../telemetry', () => ({
  monitor:
    (fn: (...args: unknown[]) => unknown) =>
    (...args: unknown[]) => {
      try {
        return fn(...args);
      } catch {
        return undefined;
      }
    },
}));

const DD_TRACE_SPAN_CHANNEL = 'datadog:apm:electron:export';

function createSpan(overrides: Partial<ExportedSpan> = {}) {
  return {
    trace_id: BigInt(123),
    span_id: BigInt(456),
    parent_id: BigInt(0),
    name: 'http.request',
    service: 'test-service',
    resource: 'GET /api/data',
    type: 'http',
    error: 0,
    meta: {
      'http.url': 'https://example.com/api/data',
      'http.method': 'GET',
      'http.status_code': '200',
    },
    metrics: {},
    start: 1_000_000_000, // 1000ms in nanoseconds
    duration: 50_000_000, // 50ms in nanoseconds
    ...overrides,
  };
}

describe('SpanProcessor', () => {
  let eventManager: EventManager;
  let hooks: FormatHooks;
  let processor: SpanProcessor;
  let collected: Event[];

  beforeEach(() => {
    vi.clearAllMocks();
    eventManager = new EventManager();
    hooks = createFormatHooks();
    collected = [];

    eventManager.registerHandler({
      canHandle: (_event): _event is Event => true,
      handle: (event) => collected.push(event),
    });

    processor = new SpanProcessor(eventManager, hooks, {
      env: 'test',
      service: 'test-service',
      site: 'datadoghq.com',
    } as Configuration);
  });

  afterEach(() => {
    processor.stop();
  });

  function publish(traces: unknown[][]) {
    DiagnosticsChannel.channel(DD_TRACE_SPAN_CHANNEL).publish(traces);
  }

  describe('HTTP spans', () => {
    it('should emit both a span envelope and a RUM resource for HTTP spans', () => {
      const span = createSpan();
      publish([[span]]);

      const rawEvents = collected.filter((e) => e.kind === EventKind.RAW) as RawRumEvent[];
      const serverEvents = collected.filter((e) => e.kind === EventKind.SERVER) as ServerSpansEvent[];

      expect(rawEvents).toHaveLength(1);
      expect(rawEvents[0].format).toBe(EventFormat.RUM);
      expect(rawEvents[0].source).toBe(EventSource.MAIN);
      expect((rawEvents[0].data as { type: string }).type).toBe('resource');

      expect(serverEvents).toHaveLength(1);
      expect(serverEvents[0].track).toBe(EventTrack.SPANS);
    });

    it('should convert trace/span IDs to decimal in RUM resources', () => {
      const span = createSpan({ trace_id: BigInt(255), span_id: BigInt(16) });
      publish([[span]]);

      const rawEvent = collected.find((e) => e.kind === EventKind.RAW) as RawRumEvent;
      const resource = rawEvent.data as { _dd: { trace_id: string; span_id: string } };
      expect(resource._dd.trace_id).toBe('255');
      expect(resource._dd.span_id).toBe('16');
    });

    it('should convert trace/span IDs to hex in span envelopes', () => {
      const span = createSpan({ trace_id: BigInt(255), span_id: BigInt(16) });
      publish([[span]]);

      const serverEvent = collected.find((e) => e.kind === EventKind.SERVER) as ServerSpansEvent;
      const payload = serverEvent.data as { spans: { trace_id: string; span_id: string }[] };
      expect(payload.spans[0].trace_id).toBe('ff');
      expect(payload.spans[0].span_id).toBe('10');
    });

    it('should map HTTP method and status code to the RUM resource', () => {
      const span = createSpan({
        meta: { 'http.url': 'https://example.com', 'http.method': 'POST', 'http.status_code': '201' },
      });
      publish([[span]]);

      const rawEvent = collected.find((e) => e.kind === EventKind.RAW) as RawRumEvent;
      const resource = rawEvent.data as { resource: { method: string; status_code: number } };
      expect(resource.resource.method).toBe('POST');
      expect(resource.resource.status_code).toBe(201);
    });

    it('should default method to GET and status_code to 0 when missing', () => {
      const span = createSpan({ meta: { 'http.url': 'https://example.com' } });
      publish([[span]]);

      const rawEvent = collected.find((e) => e.kind === EventKind.RAW) as RawRumEvent;
      const resource = rawEvent.data as { resource: { method: string; status_code: number } };
      expect(resource.resource.method).toBe('GET');
      expect(resource.resource.status_code).toBe(0);
    });
  });

  describe('non-HTTP spans', () => {
    it('should emit only a span envelope, not a RUM resource', () => {
      const span = createSpan({ type: 'system', meta: {} });
      publish([[span]]);

      const rawEvents = collected.filter((e) => e.kind === EventKind.RAW);
      const serverEvents = collected.filter((e) => e.kind === EventKind.SERVER);

      expect(rawEvents).toHaveLength(0);
      expect(serverEvents).toHaveLength(1);
    });
  });

  describe('SDK request filtering', () => {
    it('should filter out requests to the intake hostname', () => {
      const span = createSpan({
        meta: { 'http.url': 'https://browser-intake-datadoghq.com/api/v2/rum', 'http.method': 'POST' },
      });
      publish([[span]]);

      expect(collected).toHaveLength(0);
    });

    it('should filter out requests to subdomain intake hostnames (e.g. us3.datadoghq.com)', () => {
      processor.stop();
      processor = new SpanProcessor(eventManager, hooks, {
        env: 'test',
        service: 'test-service',
        site: 'us3.datadoghq.com',
      } as Configuration);
      publish([
        [
          createSpan({
            meta: { 'http.url': 'https://browser-intake-us3-datadoghq.com/api/v2/rum', 'http.method': 'POST' },
          }),
        ],
      ]);

      expect(collected).toHaveLength(0);
    });

    it('should filter out requests to the configured proxy hostname', () => {
      processor.stop();
      processor = new SpanProcessor(eventManager, hooks, {
        env: 'test',
        service: 'test-service',
        site: 'datadoghq.com',
        proxy: 'http://localhost:9999/api/v2/rum',
      } as Configuration);
      publish([[createSpan({ meta: { 'http.url': 'http://localhost:9999/api/v2/rum', 'http.method': 'POST' } })]]);

      expect(collected).toHaveLength(0);
    });

    it('should not filter localhost requests when no proxy is configured', () => {
      const span = createSpan({ meta: { 'http.url': 'http://localhost:3000/api/data', 'http.method': 'GET' } });
      publish([[span]]);

      expect(collected.length).toBeGreaterThan(0);
    });

    it('should filter spans whose resource contains the intake hostname', () => {
      const span = createSpan({
        type: 'dns',
        resource: 'browser-intake-datadoghq.com',
        meta: {},
      });
      publish([[span]]);

      expect(collected).toHaveLength(0);
    });

    it('should filter spans whose resource contains the proxy hostname', () => {
      processor.stop();
      processor = new SpanProcessor(eventManager, hooks, {
        env: 'test',
        service: 'test-service',
        site: 'datadoghq.com',
        proxy: 'http://localhost:9999/api/v2/rum',
      } as Configuration);
      const span = createSpan({
        type: 'tls',
        resource: 'tls.connect localhost:9999',
        meta: {},
      });
      publish([[span]]);

      expect(collected).toHaveLength(0);
    });

    it('should not filter external HTTP requests', () => {
      const span = createSpan({ meta: { 'http.url': 'https://api.example.com/data', 'http.method': 'GET' } });
      publish([[span]]);

      expect(collected.length).toBeGreaterThan(0);
    });
  });

  describe('span envelope', () => {
    it('should include the env in the envelope', () => {
      publish([[createSpan()]]);

      const serverEvent = collected.find((e) => e.kind === EventKind.SERVER) as ServerSpansEvent;
      const payload = serverEvent.data as { env: string };
      expect(payload.env).toBe('test');
    });

    it('should override the span service with the configured service', () => {
      const span = createSpan({ service: 'dd-trace-default' });
      publish([[span]]);

      const serverEvent = collected.find((e) => e.kind === EventKind.SERVER) as ServerSpansEvent;
      const payload = serverEvent.data as { spans: { service: string }[] };
      expect(payload.spans[0].service).toBe('test-service');
    });

    it('should group multiple spans in a single trace envelope', () => {
      const span1 = createSpan({ name: 'span1' });
      const span2 = createSpan({ name: 'span2', type: 'system', meta: {} });
      publish([[span1, span2]]);

      const serverEvents = collected.filter((e) => e.kind === EventKind.SERVER) as ServerSpansEvent[];
      expect(serverEvents).toHaveLength(1);
      const payload = serverEvents[0].data as { spans: { name: string }[] };
      expect(payload.spans).toHaveLength(2);
    });

    it('should not emit an envelope when all spans in a trace are filtered', () => {
      const span = createSpan({
        meta: { 'http.url': 'https://browser-intake-datadoghq.com/api/v2/rum', 'http.method': 'POST' },
      });
      publish([[span]]);

      const serverEvents = collected.filter((e) => e.kind === EventKind.SERVER);
      expect(serverEvents).toHaveLength(0);
    });
  });

  describe('context enrichment', () => {
    it('should enrich span meta with hook results', () => {
      hooks.registerSpan(() => ({ meta: { '_dd.application.id': 'app-123', '_dd.session.id': 'sess-456' } }));
      publish([[createSpan()]]);

      const serverEvent = collected.find((e) => e.kind === EventKind.SERVER) as ServerSpansEvent;
      const payload = serverEvent.data as { spans: { meta: Record<string, string> }[] };
      expect(payload.spans[0].meta['_dd.application.id']).toBe('app-123');
      expect(payload.spans[0].meta['_dd.session.id']).toBe('sess-456');
    });

    it('should not emit server spans event when hooks return DISCARDED', () => {
      hooks.registerSpan(() => DISCARDED);
      publish([[createSpan()]]);

      const serverEvent = collected.find((e) => e.kind === EventKind.SERVER) as ServerSpansEvent;
      expect(serverEvent).toBeUndefined();
    });

    it('should not enrich when hooks return SKIPPED', () => {
      hooks.registerSpan(() => SKIPPED);
      publish([[createSpan()]]);

      const serverEvent = collected.find((e) => e.kind === EventKind.SERVER) as ServerSpansEvent;
      const payload = serverEvent.data as { spans: { meta: Record<string, string> }[] };
      expect(payload.spans[0].meta['_dd.application.id']).toBeUndefined();
    });
  });

  describe('stop', () => {
    it('should unsubscribe from the diagnostics channel', () => {
      processor.stop();
      publish([[createSpan()]]);

      expect(collected).toHaveLength(0);
    });
  });

  describe('error handling', () => {
    it('should not throw on malformed messages (errors caught by monitor)', () => {
      // Publish a malformed message — monitor() swallows the error
      expect(() => {
        DiagnosticsChannel.channel(DD_TRACE_SPAN_CHANNEL).publish('not an array');
      }).not.toThrow();
    });
  });
});
