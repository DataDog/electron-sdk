import * as http from 'node:http';

export const SLOW_RESPONSE_DELAY_MS = 300;

/**
 * Local HTTP server used as a controllable destination for outbound requests made by the test app.
 * Exposes `GET /status/:code` so tests can drive any response status they need, and `GET /slow/:code` which waits
 * `SLOW_RESPONSE_DELAY_MS` before writing headers so tests can assert on request timing.
 */
export class TestServer {
  private server: http.Server | null = null;
  private port = 0;
  private requestHeaders = new Map<string, http.IncomingHttpHeaders>();

  async start(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        if (req.url) {
          this.requestHeaders.set(req.url, req.headers);
        }
        const match = req.method === 'GET' && req.url ? /^\/(status|slow)\/(\d+)$/.exec(req.url) : null;
        if (match) {
          const status = Number(match[2]);
          const respond = () => {
            res.writeHead(status, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
          };
          if (match[1] === 'slow') {
            setTimeout(respond, SLOW_RESPONSE_DELAY_MS);
          } else {
            respond();
          }
        } else {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Not found' }));
        }
      });

      this.server.listen(0, '127.0.0.1', () => {
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

  urlFor(status: number): string {
    return `http://127.0.0.1:${this.port}/status/${status}`;
  }

  slowUrlFor(status: number): string {
    return `http://127.0.0.1:${this.port}/slow/${status}`;
  }

  headersFor(status: number): http.IncomingHttpHeaders {
    return this.requestHeaders.get(`/status/${status}`) ?? {};
  }
}
