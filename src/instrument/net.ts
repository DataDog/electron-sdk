import ddTrace from 'dd-trace';

export function patchNet(net: Electron.Net): void {
  const originalRequest = net.request.bind(net);

  // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any
  (net as any).request = function (options: Electron.ClientRequestConstructorOptions | string): Electron.ClientRequest {
    const opts: Electron.ClientRequestConstructorOptions =
      typeof options === 'string' ? { url: options } : { ...options };

    const method = (opts.method ?? 'GET').toUpperCase();
    const urlStr = opts.url ?? '';

    const span = ddTrace.startSpan('http.request', {
      tags: {
        'span.kind': 'client',
        'span.type': 'http',
        component: 'electron',
        'resource.name': method,
        'http.method': method,
        'http.url': urlStr,
      },
    });

    const carrier: Record<string, string> = {};
    ddTrace.inject(span, 'http_headers', carrier);
    const existingHeaders = opts.headers ?? {};
    opts.headers = { ...carrier, ...existingHeaders };

    const req = originalRequest(opts);

    let finished = false;
    const finish = (err?: unknown): void => {
      if (finished) return;
      finished = true;
      if (err !== undefined) span.setTag('error', err);
      span.finish();
    };

    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
    (req as any).on('response', (response: Electron.IncomingMessage) => {
      span.setTag('http.status_code', String(response.statusCode));
      response.on('end', () => finish());
      response.on('error', (err: unknown) => finish(err));
    });
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
    (req as any).on('error', (err: Error) => finish(err));
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
    (req as any).on('abort', () => finish());

    return req;
  };
}
