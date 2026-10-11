import * as http from 'node:http';
import zlib from 'node:zlib';
import { configurationToString } from '@datadog/openfeature-browser/rules-based';
import type {
  LogsEvent,
  RumActionEvent,
  RumErrorEvent,
  RumExecutionContextEvent,
  RumResourceEvent,
  RumViewEvent,
  RumVitalEvent,
  TelemetryEvent,
  TelemetryType,
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
  execution_context: RumExecutionContextEvent;
  action: RumActionEvent;
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
 * today — it would if debug telemetry is ever added. Telemetry relayed from a renderer is another
 * matter: the browser SDK does emit `debug` (its internal metrics), so whenever one is running — a
 * bridge window, or `test.use({ rumBrowserSdk })` on the main window — reach for
 * {@link byMainProcessTelemetryType} rather than this to assert what the Electron SDK reported.
 */
export const byTelemetryType =
  (type: TelemetryType) =>
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
 * Selects telemetry the main process emitted, i.e. the Electron SDK's own.
 *
 * Telemetry the SDK relays from a renderer keeps the browser SDK's `source`, so a count that means
 * "what the Electron SDK reported" has to filter on this rather than assume all telemetry is its own.
 */
export const isMainProcessTelemetry = (event: ReceivedEvent<TelemetryEvent>): boolean =>
  event.body.source === 'electron';

/** Selects telemetry a renderer's browser SDK assembled, which the SDK relays over the bridge. */
export const isRendererTelemetry = (event: ReceivedEvent<TelemetryEvent>): boolean => !isMainProcessTelemetry(event);

/**
 * Selects telemetry of a given type that the main process emitted, i.e. the Electron SDK's own.
 * The pairing {@link byTelemetryType} calls for, so an assertion about what the Electron SDK reported
 * cannot be satisfied by an event relayed from a renderer.
 */
export const byMainProcessTelemetryType =
  (type: TelemetryType) =>
  (event: ReceivedEvent<TelemetryEvent>): boolean =>
    isMainProcessTelemetry(event) && byTelemetryType(type)(event);

/** Selects telemetry of a given type that the SDK relayed from a renderer. */
export const byRendererTelemetryType =
  (type: TelemetryType) =>
  (event: ReceivedEvent<TelemetryEvent>): boolean =>
    isRendererTelemetry(event) && byTelemetryType(type)(event);

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
  private logs: ReceivedEvent<LogsEvent>[] = [];
  private rulesRequests: { timestamp: number; url: string; headers: Record<string, string> }[] = [];
  private rulesMode: 'ok' | 'unavailable' | 'error' | 'hang' = 'ok';
  private exposures: {
    timestamp: number;
    body: Record<string, unknown>;
    headers: Record<string, string>;
    ddforward: string;
  }[] = [];
  private exposuresMode: 'ok' | 'reject' = 'ok';
  private flagEvaluations: { timestamp: number; body: Record<string, unknown>; ddforward: string }[] = [];
  private logRequestSizes: number[] = [];
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

  /**
   * Logs live in their own store rather than in `rumEvents`: they arrive on a different track and
   * carry no `type` discriminator, so the `EventBodyByType` reads cannot select them.
   */
  private storeLogs(parsedBody: unknown, headers: Record<string, string>, ddforward: string) {
    const items = Array.isArray(parsedBody) ? (parsedBody as LogsEvent[]) : [parsedBody as LogsEvent];
    this.logRequestSizes.push(items.length);
    for (const item of items) {
      this.logs.push({ timestamp: Date.now(), body: item, headers, ddforward });
    }
  }

  private storeTraces(parsedBody: unknown) {
    const items = Array.isArray(parsedBody) ? (parsedBody as Trace[]) : [parsedBody as Trace];
    for (const item of items) {
      this.traces.push(item);
    }
  }

  /** Configure the rules endpoint behavior (ok / 403 rules-unavailable / 503 / hang). */
  /** When 'reject', the exposures endpoint answers 500 to simulate an intake failure. */
  setExposuresMode(mode: 'ok' | 'reject'): void {
    this.exposuresMode = mode;
  }

  setRulesMode(mode: 'ok' | 'unavailable' | 'error' | 'hang'): void {
    this.rulesMode = mode;
  }

  getRulesRequests(): { timestamp: number; url: string; headers: Record<string, string> }[] {
    return this.rulesRequests;
  }

  async waitForRulesRequestCount(count: number, options?: { timeout?: number }): Promise<void> {
    const timeout = options?.timeout ?? 5000;
    const deadline = Date.now() + timeout;
    while (this.rulesRequests.length < count) {
      if (Date.now() > deadline) {
        throw new Error(`Timed out waiting for ${count} rules requests, got ${this.rulesRequests.length}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  getFlagEvaluations(): { timestamp: number; body: Record<string, unknown>; ddforward: string }[] {
    return this.flagEvaluations;
  }

  async waitForFlagEvaluationCount(count: number, options?: { timeout?: number }): Promise<void> {
    const deadline = Date.now() + (options?.timeout ?? 5000);
    while (this.flagEvaluations.length < count) {
      if (Date.now() > deadline) {
        throw new Error(`Timed out waiting for ${count} flag evaluations, got ${this.flagEvaluations.length}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  getExposures(): { timestamp: number; body: Record<string, unknown>; headers: Record<string, string> }[] {
    return this.exposures;
  }

  async waitForExposureCount(count: number, options?: { timeout?: number }): Promise<void> {
    const timeout = options?.timeout ?? 5000;
    const deadline = Date.now() + timeout;
    while (this.exposures.length < count) {
      if (Date.now() > deadline) {
        throw new Error(`Timed out waiting for ${count} exposures, got ${this.exposures.length}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
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

        // The feature flags rules request goes through the proxy root: upstream sends it
        // to `<flaggingProxy>/?dd_env=<env>` (the proxy is expected to route internally),
        // so it arrives here as a GET with a dd_env query param.
        if (req.method === 'GET' && url.searchParams.has('dd_env')) {
          this.rulesRequests.push({
            timestamp: Date.now(),
            url: url.toString(),
            headers: req.headers as Record<string, string>,
          });
          if (this.rulesMode === 'hang') {
            // Never respond: the SDK must abort after its fetch timeout.
            return;
          }
          if (this.rulesMode === 'unavailable') {
            req.resume();
            res.writeHead(403, { 'Content-Type': 'application/vnd.api+json' });
            res.end(
              JSON.stringify({
                errors: [{ detail: 'Allow local rule evaluation in client SDKs is disabled for this application' }],
              })
            );
            return;
          }
          if (this.rulesMode === 'error') {
            req.resume();
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'unavailable' }));
            return;
          }
          req.resume();
          const body = flagsBinary();
          res.writeHead(200, { 'Content-Type': 'application/protobuf', 'Content-Length': String(body.length) });
          res.end(body);
          return;
        }

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
            if (ddforward.startsWith('/api/v2/exposures')) {
              for (const item of parsedBody as Record<string, unknown>[]) {
                this.exposures.push({ timestamp: Date.now(), body: item, headers, ddforward });
              }
              if (this.exposuresMode === 'reject') {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'exposures intake failure' }));
                return;
              }
            } else if (ddforward.startsWith('/api/v2/flagevaluation')) {
              for (const item of parsedBody as Record<string, unknown>[]) {
                this.flagEvaluations.push({ timestamp: Date.now(), body: item, ddforward });
              }
            } else if (ddforward.startsWith('/api/v2/spans')) {
              this.storeTraces(parsedBody);
            } else if (ddforward.startsWith('/api/v2/logs')) {
              this.storeLogs(parsedBody, headers, ddforward);
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

  /**
   * Waits for at least `count` logs, optionally filtered, and returns everything matching.
   * Separate from {@link waitForEventCount} because logs are their own track and carry no `type`.
   */
  async waitForLogCount(
    count: number,
    options?: { timeout?: number; predicate?: (log: ReceivedEvent<LogsEvent>) => boolean }
  ): Promise<ReceivedEvent<LogsEvent>[]> {
    const timeout = options?.timeout ?? 10000;
    const predicate = options?.predicate ?? (() => true);
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      const matching = this.logs.filter(predicate);
      if (matching.length >= count) return matching;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    throw new Error(
      `Timed out waiting for ${count} log(s) after ${timeout}ms. Received ${this.logs.filter(predicate).length}.`
    );
  }

  getLogs(): ReceivedEvent<LogsEvent>[] {
    return [...this.logs];
  }

  getLogRequestSizes(): number[] {
    return [...this.logRequestSizes];
  }

  getReplaySegments(): ReplaySegment[] {
    return [...this.replaySegments];
  }

  clear(): void {
    this.rumEvents = [];
    this.rulesRequests = [];
    this.exposures = [];
    this.flagEvaluations = [];
    this.logs = [];
    this.logRequestSizes = [];
    this.replaySegments = [];
    this.traces = [];
    this.profilingRequests = [];
    this.quotaDecision = 'quota_ok';
  }

  getPort(): number {
    return this.port;
  }
}

// ---------------------------------------------------------------------------
// Feature flags rules fixture. Lives in this file (not a sibling module) because
// playground/tsconfig.test.json includes only intake.ts from e2e/lib.
// ---------------------------------------------------------------------------

/**
 * Hand-authored rules-based flags configuration for the e2e app (M0 S5: the protobuf
 * body is built at runtime from this object — `configurationToString` ->
 * base64 -> binary — so no generator script or committed binary is needed).
 *
 * Flags:
 * - `targeted-flag` (string): 'variant-a' when the `plan` attribute is 'pro',
 *   'str-default' otherwise.
 * - `split-flag` (boolean): 50/50 md5 shard on the targeting key; 'split-key-1' is
 *   off and 'split-key-5' is on.
 * - `disabled-flag` (boolean): no allocation, always the application default.
 */
const PROTO = 'datadog.ffe.flagging.ufc.v1.';
const type = (name: string, value: Record<string, unknown>) => ({ $typeName: PROTO + name, ...value }) as never;

const STRINGS = ['pro', 'free', 'plan', 'on', 'off', 'variant-a', 'str-default'];
const stringIndex = (value: string) => STRINGS.indexOf(value);

const fixture = type('FlagsConfiguration', {
  environmentName: 'e2e',
  flags: {
    'targeted-flag': type('Flag', {
      minimumFeatureLevel: 0,
      variationType: 1,
      variations: [
        type('Variation', {
          keyStringIndex: stringIndex('variant-a'),
          value: { case: 'stringValueIndex', value: stringIndex('variant-a') },
        }),
        type('Variation', {
          keyStringIndex: stringIndex('str-default'),
          value: { case: 'stringValueIndex', value: stringIndex('str-default') },
        }),
      ],
      allocations: [
        type('Allocation', {
          key: 'targeted-pro',
          partitionKey: [],
          targetingConditionIndex: 0,
          splits: [type('Split', { ranges: [], variationIndex: 0, serialId: 1, reason: 3 })],
          logExposureEvent: true,
        }),
        type('Allocation', {
          key: 'targeted-fallback',
          partitionKey: [],
          splits: [type('Split', { ranges: [], variationIndex: 1, reason: 3 })],
          logExposureEvent: true,
        }),
      ],
    }),
    'split-flag': type('Flag', {
      minimumFeatureLevel: 0,
      variationType: 4,
      variations: [
        type('Variation', { keyStringIndex: stringIndex('on'), value: { case: 'booleanValue', value: true } }),
        type('Variation', { keyStringIndex: stringIndex('off'), value: { case: 'booleanValue', value: false } }),
      ],
      allocations: [
        type('Allocation', {
          key: 'split-allocation',
          partitionKey: [
            type('PartitionKey', {
              kind: {
                case: 'shardMd5',
                value: type('Md5ShardPartitionKey', { salt: 'e2e-salt', attributeIndex: 1, totalShards: 100n }),
              },
            }),
          ],
          splits: [
            type('Split', {
              ranges: [type('PartitionRange', { from: 0n, to: 50n })],
              variationIndex: 0,
              serialId: 2,
              reason: 2,
            }),
            type('Split', {
              ranges: [type('PartitionRange', { from: 50n, to: 100n })],
              variationIndex: 1,
              serialId: 2,
              reason: 2,
            }),
          ],
          logExposureEvent: true,
        }),
      ],
    }),
    'disabled-flag': type('Flag', {
      minimumFeatureLevel: 0,
      variationType: 4,
      variations: [
        type('Variation', { keyStringIndex: stringIndex('on'), value: { case: 'booleanValue', value: true } }),
      ],
      allocations: [],
    }),
  },
  attributes: [
    type('AttributeReference', {
      kind: {
        case: 'attributePath',
        value: type('AttributePath', {
          segments: [
            type('AttributePathSegment', { kind: { case: 'objectKeyStringIndex', value: stringIndex('plan') } }),
          ],
        }),
      },
    }),
    type('AttributeReference', { kind: { case: 'targetingKey', value: {} } }),
  ],
  strings: STRINGS,
  regexes: [],
  versions: [],
  jsonStrings: [],
  conditions: [
    type('Condition', {
      kind: {
        case: 'stringMembership',
        value: type('StringMembershipCondition', {
          attributeIndex: 0,
          stringIndexes: [stringIndex('pro')],
          negate: false,
        }),
      },
    }),
  ],
});

const wire = configurationToString({ rules: { response: fixture } });
const wireJSON = JSON.parse(wire) as { rules: { response: string } };

/** The rules endpoint response body: the protobuf configuration binary. */
export const flagsBinary = (): Buffer => Buffer.from(wireJSON.rules.response, 'base64');
