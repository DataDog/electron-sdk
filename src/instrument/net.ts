import ddTrace from '../entries/instrument-prelude';
import { AsyncLocalStorage } from 'node:async_hooks';

interface PatchableNet {
  fetch?: (input: string | Request, init?: RequestInit) => Promise<Response>;
  request: (options: Electron.ClientRequestConstructorOptions | string) => Electron.ClientRequest;
}

export function patchNet(net: Electron.Net): void {
  // dd-trace's OpenTracing startSpan() does NOT inherit the active scope automatically —
  // childOf must be passed explicitly. We capture scope().active() synchronously at call
  // time so the span is correctly parented to whatever is active (e.g. an IPC handle span).
  //
  // net.fetch calls net.request internally, but via a native async boundary where
  // AsyncLocalStorage context is lost. We therefore patch net.fetch directly so the
  // span is created synchronously in the caller's scope, and suppress the inner
  // net.request span with insideFetch to avoid a duplicate orphan span.
  const insideFetch = new AsyncLocalStorage<true>();
  const patchable = net as unknown as PatchableNet;
  const originalRequest = net.request.bind(net);

  if (typeof patchable.fetch === 'function') {
    const originalFetch = patchable.fetch.bind(net);

    patchable.fetch = function (input: string | Request, init?: RequestInit): Promise<Response> {
      const url = typeof input === 'string' ? input : input.url;
      const method = (init?.method ?? (typeof input !== 'string' ? input.method : undefined) ?? 'GET').toUpperCase();

      const span = ddTrace.startSpan('http.request', {
        childOf: ddTrace.scope().active() ?? undefined,
        tags: {
          'span.kind': 'client',
          'span.type': 'http',
          component: 'electron',
          'resource.name': method,
          'http.method': method,
          'http.url': url,
        },
      });

      const carrier: Record<string, string> = {};
      ddTrace.inject(span, 'http_headers', carrier);

      // Match fetch semantics: init.headers replaces the Request's headers when provided,
      // otherwise the Request's own headers apply. Reading input.headers here is what prevents
      // tracing from silently dropping headers set on a Request object (e.g. Authorization).
      const originalHeaders =
        init?.headers !== undefined ? toRecord(init.headers) : typeof input !== 'string' ? toRecord(input.headers) : {};
      const patchedInit: RequestInit = { ...init, headers: { ...carrier, ...originalHeaders } };

      try {
        // A synchronous throw from originalFetch (before it returns a promise) skips the .then
        // handlers entirely, so we finish the span here. The .then callbacks handle the async
        // settle path; since a sync throw means .then never ran, there is no double-finish risk.
        return insideFetch.run(true, () =>
          originalFetch(input, patchedInit).then(
            (response: Response) => {
              span.setTag('http.status_code', String(response.status));
              span.finish();
              return response;
            },
            (err: unknown) => {
              span.setTag('error', err);
              span.finish();
              throw err;
            }
          )
        );
      } catch (err) {
        span.setTag('error', err);
        span.finish();
        throw err;
      }
    };
  }

  patchable.request = function (options: Electron.ClientRequestConstructorOptions | string): Electron.ClientRequest {
    // Suppress the inner span when called by our net.fetch wrapper to avoid a duplicate orphan.
    if (insideFetch.getStore()) {
      return originalRequest(options);
    }

    const opts: Electron.ClientRequestConstructorOptions =
      typeof options === 'string' ? { url: options } : { ...options };

    const method = (opts.method ?? 'GET').toUpperCase();
    const urlStr = opts.url ?? '';

    const span = ddTrace.startSpan('http.request', {
      childOf: ddTrace.scope().active() ?? undefined,
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

    let req: Electron.ClientRequest;
    try {
      // net.request validates options and can throw synchronously. The finish() closures are only
      // attached to req events below, so a sync throw would leak the span if not finished here.
      req = originalRequest(opts);
    } catch (err) {
      span.setTag('error', err);
      span.finish();
      throw err;
    }

    let finished = false;
    const finish = (err?: unknown): void => {
      if (finished) return;
      finished = true;
      if (err !== undefined) span.setTag('error', err);
      span.finish();
    };

    req.on('response', (response) => {
      span.setTag('http.status_code', String(response.statusCode));
      response.on('end', () => finish());
      response.on('error', (err) => finish(err));
    });
    req.on('error', (err) => finish(err));
    req.on('abort', () => finish());

    return req;
  };
}

// Normalize any HeadersInit form (Headers, array of tuples, or plain record) into a plain record.
// Routing through Headers gives spec-correct lowercase key normalization and duplicate-key combining
// for free, so all input forms behave consistently.
function toRecord(headers: HeadersInit): Record<string, string> {
  const record: Record<string, string> = {};
  new Headers(headers).forEach((value, key) => {
    record[key] = value;
  });
  return record;
}
