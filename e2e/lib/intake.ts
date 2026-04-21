import * as http from 'node:http';

export interface ReceivedEvent {
  timestamp: number;
  body: unknown;
  headers: Record<string, string>;
}

const byType = (type: string) => (event: ReceivedEvent) => (event.body as { type?: string }).type === type;

export class Intake {
  private server: http.Server | null = null;
  private events: ReceivedEvent[] = [];
  private port = 0;

  async start(port = 0): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        if (req.method === 'POST' && req.url === '/api/v2/rum') {
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

              // BatchConsumer sends events as a JSON array — unpack each as an individual event
              const items = Array.isArray(parsedBody) ? (parsedBody as unknown[]) : [parsedBody];
              for (const item of items) {
                this.events.push({
                  timestamp: Date.now(),
                  body: item,
                  headers,
                });
              }

              res.writeHead(202, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ status: 'accepted' }));
            } catch {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Invalid JSON' }));
            }
          });
        } else {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Not found' }));
        }
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
      const matchingEvents = this.events.filter(byType(type)).filter(byPredicate);
      if (matchingEvents.length >= count) {
        return matchingEvents;
      }
      await new Promise((resolve) => setTimeout(resolve, pollInterval));
    }

    const received = this.events.filter(byType(type)).filter(byPredicate);
    throw new Error(
      `Timed out waiting for ${count} "${type}" event(s) after ${timeout}ms. Received ${received.length}.`
    );
  }

  async assertNoNewEvents(type: string, duration = 500): Promise<void> {
    const startTime = Date.now();
    const pollInterval = 100;

    while (Date.now() - startTime < duration) {
      const matchingEvents = this.events.filter(byType(type));
      if (matchingEvents.length > 0) {
        throw new Error(`Expected no "${type}" events but received ${matchingEvents.length} within ${duration}ms.`);
      }
      await new Promise((resolve) => setTimeout(resolve, pollInterval));
    }
  }

  clear(): void {
    this.events = [];
  }

  getPort(): number {
    return this.port;
  }
}
