import * as http from 'http';

interface ReceivedEvent {
  timestamp: number;
  body: unknown;
  headers: Record<string, string>;
}

export class Intake {
  private server: http.Server | null = null;
  private events: ReceivedEvent[] = [];
  private port: number = 0;

  async start(port: number = 0): Promise<number> {
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

              this.events.push({
                timestamp: Date.now(),
                body: parsedBody,
                headers,
              });

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

  getEvents(): ReceivedEvent[] {
    return this.events;
  }

  clear(): void {
    this.events = [];
  }

  getPort(): number {
    return this.port;
  }
}
