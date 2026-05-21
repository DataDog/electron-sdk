import * as http from 'node:http';

/**
 * Fake Datadog intake used to assert what the SDK sends.
 *
 * The SDK is configured (via `proxy`) to POST events to this server instead of the real Datadog endpoint.
 * The `ddforward` query param in the request URL routes events to either the `rumEvents` store or the `traces` store.
 * Tests read back captured data through `getEventsByType`, `waitForEventCount`, `waitForSpan`, and `assertNoNewEvents`.
 */
export interface ReceivedEvent {
  timestamp: number;
  body: unknown;
  headers: Record<string, string>;
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

const byType = (type: string) => (event: ReceivedEvent) => (event.body as { type?: string }).type === type;

export class Intake {
  private server: http.Server | null = null;
  private rumEvents: ReceivedEvent[] = [];
  private traces: Trace[] = [];
  private port = 0;

  private storeRumEvents(parsedBody: unknown, headers: Record<string, string>) {
    const items = Array.isArray(parsedBody) ? (parsedBody as unknown[]) : [parsedBody];
    for (const item of items) {
      this.rumEvents.push({
        timestamp: Date.now(),
        body: item,
        headers,
      });
    }
  }

  private storeTraces(parsedBody: unknown) {
    const items = Array.isArray(parsedBody) ? (parsedBody as Trace[]) : [parsedBody as Trace];
    for (const item of items) {
      this.traces.push(item);
    }
  }

  async start(port = 0): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        if (req.method !== 'POST') {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Not found' }));
          return;
        }

        let body = '';

        req.on('data', (chunk: Buffer) => {
          body += chunk.toString();
        });

        req.on('end', () => {
          try {
            const parsedBody: unknown = JSON.parse(body);
            const headers: Record<string, string> = {};

            for (const [key, value] of Object.entries(req.headers)) {
              if (typeof value === 'string') {
                headers[key.toLowerCase()] = value;
              } else if (Array.isArray(value)) {
                headers[key.toLowerCase()] = value.join(', ');
              }
            }

            const ddforward = new URL(req.url ?? '/', 'http://localhost').searchParams.get('ddforward') ?? '';

            if (ddforward.startsWith('/api/v2/spans')) {
              this.storeTraces(parsedBody);
            } else {
              // Default: treat as RUM events (covers /api/v2/rum and any other path)
              this.storeRumEvents(parsedBody, headers);
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

  async getEventsByType(
    type: string,
    options?: { timeout?: number; predicate?: (event: ReceivedEvent) => boolean }
  ): Promise<ReceivedEvent[]> {
    // return as soon as we have one event
    return this.waitForEventCount(type, 1, options);
  }

  async waitForEventCount(
    type: string,
    count: number,
    options?: { timeout?: number; predicate?: (event: ReceivedEvent) => boolean }
  ): Promise<ReceivedEvent[]> {
    const timeout = options?.timeout ?? 5000;
    const byPredicate = options?.predicate ?? (() => true);
    const startTime = Date.now();
    const pollInterval = 100;

    while (Date.now() - startTime < timeout) {
      const matchingEvents = this.rumEvents.filter(byType(type)).filter(byPredicate);
      if (matchingEvents.length >= count) {
        return matchingEvents;
      }
      await new Promise((resolve) => setTimeout(resolve, pollInterval));
    }

    const received = this.rumEvents.filter(byType(type)).filter(byPredicate);
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

  async assertNoNewEvents(type: string, duration = 500): Promise<void> {
    const startTime = Date.now();
    const pollInterval = 100;

    while (Date.now() - startTime < duration) {
      const matchingEvents = this.rumEvents.filter(byType(type));
      if (matchingEvents.length > 0) {
        throw new Error(`Expected no "${type}" events but received ${matchingEvents.length} within ${duration}ms.`);
      }
      await new Promise((resolve) => setTimeout(resolve, pollInterval));
    }
  }

  clear(): void {
    this.rumEvents = [];
    this.traces = [];
  }

  getPort(): number {
    return this.port;
  }
}
