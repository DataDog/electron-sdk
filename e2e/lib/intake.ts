import * as http from 'node:http';
import zlib from 'node:zlib';
import type {
  RumErrorEvent,
  RumResourceEvent,
  RumViewEvent,
  RumVitalEvent,
  TelemetryEvent,
} from '@datadog/electron-sdk';

/**
 * Body shape keyed by the `type` the read methods filter on, so a read returns that type rather than
 * `unknown` and call sites need no cast to reach its fields.
 *
 * `vital` and `telemetry` each cover several shapes behind a single `type`, so they resolve to a
 * union. Beware that the generated event types carry `[k: string]: unknown` index signatures, so
 * member-specific fields (`vital.step_type`, `telemetry.configuration`) degrade to `unknown` on the
 * union and stop being checked — a call site wanting those must assert to the member it expects. That
 * assertion is checked against the union, so asserting the body of a `vital` read to a telemetry event
 * is a compile error, where asserting from `unknown` allowed it and failed at runtime.
 */
export interface EventBodyByType {
  view: RumViewEvent;
  error: RumErrorEvent;
  resource: RumResourceEvent;
  vital: RumVitalEvent;
  telemetry: TelemetryEvent;
  // PROVISIONAL: the `execution_context` and `action` event types are not yet part of the SDK's
  // public API (see src/domain/rum/types/executionContext.types.ts and
  // src/domain/rum/types/rendererRumEvent.types.ts), so these entries can't reference their real
  // types here. Call sites cast `.body` to their own local shape, as the e2e scenarios do.
  execution_context: Record<string, unknown>;
  action: Record<string, unknown>;
}

export type EventType = keyof EventBodyByType;

export interface ReceivedEvent<Body = unknown> {
  timestamp: number;
  body: Body;
  headers: Record<string, string>;
  ddforward: string;
}

interface ReadOptions<T extends EventType> {
  timeout?: number;
  predicate?: (event: ReceivedEvent<EventBodyByType[T]>) => boolean;
}

interface SettledReadOptions<T extends EventType> extends ReadOptions<T> {
  /** How long the result must stay unchanged before it is considered final. */
  settle?: number;
}

export interface ReplaySegment {
  timestamp: number;
  /** Parsed JSON from the multipart `event` field — segment metadata + size fields. */
  metadata: Record<string, unknown>;
  headers: Record<string, string>;
  /**
   * The rrweb records decoded from the compressed `segment` blob, when it was a
   * standalone-inflatable ZLIB stream (the common single-segment case). Undefined
   * if the `segment` part was absent or could not be inflated on its own.
   */
  records?: unknown[];
}

export interface Trace {
  env: string;
  spans: Span[];
}

export interface Span {
  trace_id: string;
  span_id: string;
  parent_id: string;
  name: string;
  service: string;
  meta: Record<string, string>;
  [key: string]: unknown;
}

export interface ProfilingRequest {
  timestamp: number;
  contentType: string;
  headers: Record<string, string>;
}

const byType = (type: string) => (event: ReceivedEvent) => (event.body as { type?: string }).type === type;

/**
 * Splits a Buffer on a byte delimiter, returning the chunks between delimiters.
 * Operates on raw bytes (not utf8) so binary multipart parts survive intact.
 */
function splitBuffer(buf: Buffer, delimiter: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  let start = 0;
  let idx = buf.indexOf(delimiter, start);
  while (idx !== -1) {
    if (idx > start) parts.push(buf.subarray(start, idx));
    start = idx + delimiter.length;
    idx = buf.indexOf(delimiter, start);
  }
  if (start < buf.length) parts.push(buf.subarray(start));
  return parts;
}

/**
 * Predicate for the `telemetry` event type, which carries several telemetry types on the RUM track.
 * Pass it to `getEventsByType`/`waitForEventCount` to select one, rather than assuming the type under
 * test is the only telemetry received.
 *
 * `'log'` selects message events, which the schema splits further by `status` into `debug` and
 * `error`. The SDK only ever emits `error` (see `RawTelemetryError`), so this needs no second filter
 * today — it would if debug telemetry is ever added.
 */
export const byTelemetryType =
  (type: 'log' | 'configuration' | 'usage') =>
  (event: ReceivedEvent<TelemetryEvent>): boolean =>
    event.body.telemetry?.type === type;

/** URL of the view the SDK emits for the main process; every other view comes from a bridge window. */
const MAIN_PROCESS_VIEW_URL = 'electron://main-process';

/** Selects the view the main process emits. */
export const isMainProcessView = (event: ReceivedEvent<RumViewEvent>): boolean =>
  event.body.view.url === MAIN_PROCESS_VIEW_URL;

/** Selects views emitted by a bridge window, i.e. every view but the main process one. */
export const isBridgeView = (event: ReceivedEvent<RumViewEvent>): boolean => !isMainProcessView(event);

/**
 * Fake Datadog intake used to assert what the SDK sends.
 *
 * The SDK is configured (via `proxy`) to POST events to this server instead of the real Datadog endpoint.
 * The `ddforward` query param in the request URL routes events to either the `rumEvents` store or the `traces` store.
 * Tests read back captured data through `getEventsByType`, `getSettledEventsByType`, `waitForEventCount`,
 * `waitForSpan`, and `assertNoNewEvents`.
 */
export class Intake {
  private server: http.Server | null = null;
  private rumEvents: ReceivedEvent[] = [];
  private replaySegments: ReplaySegment[] = [];
  private traces: Trace[] = [];
  private profilingRequests: ProfilingRequest[] = [];
  private port = 0;
  private quotaDecision: 'quota_ok' | 'quota_ko' = 'quota_ok';

  private storeRumEvents(parsedBody: unknown, headers: Record<string, string>, ddforward: string) {
    const items = Array.isArray(parsedBody) ? (parsedBody as unknown[]) : [parsedBody];
    for (const item of items) {
      this.rumEvents.push({
        timestamp: Date.now(),
        body: item,
        headers,
        ddforward,
      });
    }
  }

  private storeReplaySegment(rawBody: Buffer, headers: Record<string, string>) {
    const contentType = headers['content-type'] ?? '';
    const boundaryMatch = /boundary=([^\s;]+)/.exec(contentType);
    if (!boundaryMatch) return;

    // Parse the multipart body on the raw Buffer (not a utf8 string): the `segment`
    // part is deflate-compressed binary and would be corrupted by a utf8 round-trip.
    const delimiter = Buffer.from(`--${boundaryMatch[1]}`);
    let metadata: Record<string, unknown> | undefined;
    let compressed: Buffer | undefined;

    for (const part of splitBuffer(rawBody, delimiter)) {
      // Each part is `\r\n<headers>\r\n\r\n<body>\r\n`. The preamble and the closing
      // `--` marker have no header/body separator, so they're skipped here.
      const headerEnd = part.indexOf('\r\n\r\n');
      if (headerEnd === -1) continue;

      const partHeaders = part.subarray(0, headerEnd).toString('utf8');
      let body = part.subarray(headerEnd + 4);
      // Strip the trailing CRLF that precedes the next delimiter.
      if (body.length >= 2 && body[body.length - 2] === 0x0d && body[body.length - 1] === 0x0a) {
        body = body.subarray(0, body.length - 2);
      }

      if (partHeaders.includes('name="event"')) {
        try {
          metadata = JSON.parse(body.toString('utf8')) as Record<string, unknown>;
        } catch {
          // malformed event part — ignore
        }
      } else if (partHeaders.includes('name="segment"')) {
        compressed = body;
      }
    }

    if (!metadata) return;

    const segment: ReplaySegment = { timestamp: Date.now(), metadata, headers };

    if (compressed) {
      try {
        // A single segment is a self-contained ZLIB stream (header + full-flush body +
        // final block + Adler-32), so it inflates standalone. Continuation segments carry
        // a cumulative Adler-32 that won't match a lone stream — those stay undecoded.
        const inflated = zlib.inflateSync(compressed);
        const parsed = JSON.parse(inflated.toString('utf8')) as { records?: unknown[] };
        segment.records = parsed.records ?? [];
      } catch {
        // segment blob not standalone-inflatable — leave records undefined
      }
    }

    this.replaySegments.push(segment);
  }

  private storeTraces(parsedBody: unknown) {
    const items = Array.isArray(parsedBody) ? (parsedBody as Trace[]) : [parsedBody as Trace];
    for (const item of items) {
      this.traces.push(item);
    }
  }

  setQuotaResponse(decision: 'quota_ok' | 'quota_ko'): void {
    this.quotaDecision = decision;
  }

  async start(port = 0): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        const url = new URL(req.url ?? '/', 'http://localhost');
        const ddforward = url.searchParams.get('ddforward') ?? '';
        const ddforwardSubdomain = url.searchParams.get('ddforwardSubdomain') ?? '';

        if (req.method === 'GET' && ddforwardSubdomain === 'quota') {
          const admitted = this.quotaDecision === 'quota_ok';
          // Mirror the real quota API: `reason` is an admission reason, not the decision itself
          // (a denial reports why, e.g. `quota_exceeded`).
          const reason = admitted ? 'quota_ok' : 'quota_exceeded';
          req.resume();
          res.writeHead(admitted ? 200 : 429, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ data: { attributes: { admitted, reason } } }));
          return;
        }

        if (req.method !== 'POST') {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Not found' }));
          return;
        }

        const chunks: Buffer[] = [];

        req.on('data', (chunk: Buffer) => {
          chunks.push(chunk);
        });

        if (ddforward.startsWith('/api/v2/profile')) {
          req.resume();
          req.on('end', () => {
            const headers: Record<string, string> = {};
            for (const [key, value] of Object.entries(req.headers)) {
              if (typeof value === 'string') headers[key.toLowerCase()] = value;
            }
            this.profilingRequests.push({
              timestamp: Date.now(),
              contentType: req.headers['content-type'] ?? '',
              headers,
            });
            res.writeHead(200);
            res.end();
          });
          return;
        }

        req.on('end', () => {
          const rawBody = Buffer.concat(chunks);
          const headers: Record<string, string> = {};

          for (const [key, value] of Object.entries(req.headers)) {
            if (typeof value === 'string') {
              headers[key.toLowerCase()] = value;
            } else if (Array.isArray(value)) {
              headers[key.toLowerCase()] = value.join(', ');
            }
          }

          const isMultipart = (headers['content-type'] ?? '').includes('multipart/form-data');

          if (ddforward.startsWith('/api/v2/replay') || isMultipart) {
            this.storeReplaySegment(rawBody, headers);
            res.writeHead(202, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'accepted' }));
            return;
          }

          try {
            const parsedBody: unknown = JSON.parse(rawBody.toString());
            if (ddforward.startsWith('/api/v2/spans')) {
              this.storeTraces(parsedBody);
            } else {
              // Default: treat as RUM events (covers /api/v2/rum and any other path)
              this.storeRumEvents(parsedBody, headers, ddforward);
            }

            res.writeHead(202, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'accepted' }));
          } catch {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid JSON' }));
          }
        });
      });

      this.server.listen(port, () => {
        const address = this.server!.address();
        if (address && typeof address === 'object') {
          this.port = address.port;
          resolve(this.port);
        } else {
          reject(new Error('Failed to get server port'));
        }
      });

      this.server.on('error', (error) => {
        reject(error);
      });
    });
  }

  async stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.server) {
        this.server.close((error) => {
          if (error) {
            reject(error);
          } else {
            this.server = null;
            resolve();
          }
        });
      } else {
        resolve();
      }
    });
  }

  /**
   * Events of `type` received so far that also match `predicate`.
   *
   * The store holds every event with an `unknown` body because the intake cannot know a shape before
   * filtering. Selecting on `type` is what establishes it, so this is the single place the
   * {@link EventBodyByType} mapping is asserted — call sites inherit it already typed.
   */
  private matching<T extends EventType>(type: T, options?: ReadOptions<T>): ReceivedEvent<EventBodyByType[T]>[] {
    const ofType = this.rumEvents.filter(byType(type)) as ReceivedEvent<EventBodyByType[T]>[];
    return options?.predicate ? ofType.filter(options.predicate) : ofType;
  }

  async getEventsByType<T extends EventType>(
    type: T,
    options?: ReadOptions<T>
  ): Promise<ReceivedEvent<EventBodyByType[T]>[]> {
    // return as soon as we have one event
    return this.waitForEventCount(type, 1, options);
  }

  /**
   * Waits for at least one matching event, then keeps polling until no new match has arrived for
   * `settle` ms, and returns everything received.
   *
   * Use this for "exactly N" assertions: `getEventsByType` returns as soon as one event matches,
   * so it cannot observe a duplicate that arrives in a later batch, and the assertion can never fail.
   */
  async getSettledEventsByType<T extends EventType>(
    type: T,
    options?: SettledReadOptions<T>
  ): Promise<ReceivedEvent<EventBodyByType[T]>[]> {
    const settle = options?.settle ?? 1000;
    const pollInterval = 100;

    let events = await this.waitForEventCount(type, 1, options);

    let quietFor = 0;
    while (quietFor < settle) {
      await new Promise((resolve) => setTimeout(resolve, pollInterval));
      const current = this.matching(type, options);
      if (current.length > events.length) {
        events = current;
        quietFor = 0;
      } else {
        quietFor += pollInterval;
      }
    }

    return events;
  }

  async waitForEventCount<T extends EventType>(
    type: T,
    count: number,
    options?: ReadOptions<T>
  ): Promise<ReceivedEvent<EventBodyByType[T]>[]> {
    const timeout = options?.timeout ?? 10000;
    const startTime = Date.now();
    const pollInterval = 100;

    while (Date.now() - startTime < timeout) {
      const matchingEvents = this.matching(type, options);
      if (matchingEvents.length >= count) {
        return matchingEvents;
      }
      await new Promise((resolve) => setTimeout(resolve, pollInterval));
    }

    const received = this.matching(type, options);
    throw new Error(
      `Timed out waiting for ${count} "${type}" event(s) after ${timeout}ms. Received ${received.length}.`
    );
  }

  async waitForSpan(predicate: (span: Span) => boolean, options?: { timeout?: number }): Promise<Span> {
    const timeout = options?.timeout ?? 10000;
    const startTime = Date.now();
    const pollInterval = 100;

    while (Date.now() - startTime < timeout) {
      for (const trace of this.traces) {
        const match = trace.spans.find(predicate);
        if (match) {
          return match;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, pollInterval));
    }

    throw new Error(
      `Timed out waiting for a matching span after ${timeout}ms. Received spans: [${
        JSON.stringify(
          this.traces.flatMap((e) => e.spans),
          null,
          2
        ) || 'none'
      }]`
    );
  }

  async assertNoNewEvents(type: EventType, duration = 500): Promise<void> {
    const startTime = Date.now();
    const pollInterval = 100;

    while (Date.now() - startTime < duration) {
      const matchingEvents = this.matching(type);
      if (matchingEvents.length > 0) {
        throw new Error(`Expected no "${type}" events but received ${matchingEvents.length} within ${duration}ms.`);
      }
      await new Promise((resolve) => setTimeout(resolve, pollInterval));
    }
  }

  /** Returns all received spans (across every trace) matching the predicate. */
  getSpans(predicate: (span: Span) => boolean = () => true): Span[] {
    return this.traces.flatMap((trace) => trace.spans).filter(predicate);
  }

  getProfilingRequests(): ProfilingRequest[] {
    return [...this.profilingRequests];
  }

  async waitForProfilingRequest(options?: { timeout?: number }): Promise<ProfilingRequest[]> {
    const timeout = options?.timeout ?? 10000;
    const startTime = Date.now();
    while (Date.now() - startTime < timeout) {
      if (this.profilingRequests.length > 0) return [...this.profilingRequests];
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Timed out waiting for profiling request after ${timeout}ms`);
  }

  async assertNoProfilingRequest(duration = 1000): Promise<void> {
    const startTime = Date.now();
    while (Date.now() - startTime < duration) {
      if (this.profilingRequests.length > 0) {
        throw new Error(`Expected no profiling requests but received ${this.profilingRequests.length}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  async waitForReplaySegment(options?: {
    timeout?: number;
    predicate?: (segment: ReplaySegment) => boolean;
  }): Promise<ReplaySegment> {
    const timeout = options?.timeout ?? 10000;
    const predicate = options?.predicate ?? (() => true);
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      const match = this.replaySegments.find(predicate);
      if (match) return match;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    throw new Error(`Timed out waiting for a replay segment after ${timeout}ms.`);
  }

  getReplaySegments(): ReplaySegment[] {
    return [...this.replaySegments];
  }

  clear(): void {
    this.rumEvents = [];
    this.replaySegments = [];
    this.traces = [];
    this.profilingRequests = [];
    this.quotaDecision = 'quota_ok';
  }

  getPort(): number {
    return this.port;
  }
}
