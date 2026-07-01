import ddTrace from '../entries/instrument-prelude';
import { AsyncLocalStorage } from 'node:async_hooks';
import { callMonitored, monitorInstrumentation, monitor } from '../domain/telemetry';

interface PatchableNet {
  fetch?: (input: string | Request, init?: RequestInit) => Promise<Response>;
  request: (options: Electron.ClientRequestConstructorOptions | string, ...rest: unknown[]) => Electron.ClientRequest;
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
  const originalRequest = patchable.request.bind(net);

  if (typeof patchable.fetch === 'function') {
    const originalFetch = patchable.fetch.bind(net);

    patchable.fetch = function (input: string | Request, init?: RequestInit): Promise<Response> {
      let span: ReturnType<typeof ddTrace.startSpan> | undefined;
      let patchedInit: RequestInit = { ...init };

      const response = monitorInstrumentation<Promise<Response>>(
        ({ onError }) => {
          const url = typeof input === 'string' ? input : input.url;
          const method = (
            init?.method ??
            (typeof input !== 'string' ? input.method : undefined) ??
            'GET'
          ).toUpperCase();

          span = ddTrace.startSpan('http.request', {
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
            init?.headers !== undefined
              ? toRecord(init.headers)
              : typeof input !== 'string'
                ? toRecord(input.headers)
                : {};
          patchedInit = { ...init, headers: { ...carrier, ...originalHeaders } };

          // A synchronous throw from originalFetch (before it returns a promise) is finished here.
          onError((err) => {
            span?.setTag('error', err);
            span?.finish();
          });
        },
        () => insideFetch.run(true, () => originalFetch(input, patchedInit))
      );

      // Finish the span when the fetch settles and hand the resulting promise back to the caller
      // (mirrors dd-trace's tracePromise). Returning this chained promise — rather than observing the
      // caller's promise on a side channel — keeps two properties: a fire-and-forget fetch that
      // rejects still surfaces via process 'unhandledRejection' (we re-reject instead of swallowing),
      // and a caller that does handle the rejection gets no spurious unhandledRejection.
      //
      // The span finishes on promise resolution (response headers), not after the body is consumed —
      // matching dd-trace's FetchPlugin; the stream-based net.request path below finishes on the
      // response 'end'/'error'/'close' events like dd-trace's http client.
      return response.then(
        (result) => {
          callMonitored(() => {
            span?.setTag('http.status_code', String(result.status));
            span?.finish();
          });
          return result;
        },
        (err: unknown) => {
          callMonitored(() => {
            span?.setTag('error', err);
            span?.finish();
          });
          throw err;
        }
      );
    };
  }

  patchable.request = function (
    options: Electron.ClientRequestConstructorOptions | string,
    ...rest: unknown[]
  ): Electron.ClientRequest {
    // Forward any extra arguments (e.g. a response callback) untouched so instrumentation never
    // drops them, matching dd-trace's wrapper which re-applies all arguments.
    // Suppress the inner span when called by our net.fetch wrapper to avoid a duplicate orphan.
    if (insideFetch.getStore()) {
      return originalRequest(options, ...rest);
    }

    const opts: Electron.ClientRequestConstructorOptions =
      typeof options === 'string' ? { url: options } : { ...options };

    let span: ReturnType<typeof ddTrace.startSpan> | undefined;
    let finished = false;
    const finish = (err?: unknown): void => {
      if (finished) return;
      finished = true;
      if (err !== undefined) span?.setTag('error', err);
      span?.finish();
    };

    return monitorInstrumentation<Electron.ClientRequest>(
      ({ onResult, onError }) => {
        const method = (opts.method ?? 'GET').toUpperCase();
        const urlStr = resolveRequestUrl(opts);

        span = ddTrace.startSpan('http.request', {
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
        opts.headers = mergeHeaders(carrier, opts.headers ?? {});

        // net.request validates options and can throw synchronously. The finish() closures are only
        // attached to req events on success, so onError finishes the span on a sync throw.
        onError((err) => finish(err));

        // The req event listeners are side-channel (fire-and-forget) so each is wrapped in monitor().
        onResult((req) => {
          req.on(
            'response',
            monitor((response) => {
              span?.setTag('http.status_code', String(response.statusCode));
              response.on(
                'end',
                monitor(() => finish())
              );
              response.on(
                'error',
                monitor((err: unknown) => finish(err))
              );
            })
          );
          req.on(
            'error',
            monitor((err: unknown) => finish(err))
          );
          req.on(
            'abort',
            monitor(() => finish())
          );
          // Status-only callers never read the response body, so the response 'end' event may never
          // fire and the span would leak. Electron guarantees the request 'close' event as the final
          // transaction event; finish() is idempotent so this is a no-op when 'end'/'error'/'abort'
          // already finished (and never fires early, since 'close' follows 'end').
          req.on(
            'close',
            monitor(() => finish())
          );
        });
      },
      () => originalRequest(opts, ...rest)
    );
  };
}

// Resolve the request URL for the http.url tag. net.request accepts either a single `url` or
// structured options (protocol/host/hostname/port/path); without this, structured calls tag an empty
// http.url and SpanProcessor.isHttpSpan() would drop them, losing the RUM resource. Defaults match
// Electron's: protocol 'http:', path '/'. `host` is already 'hostname:port' when provided.
function resolveRequestUrl(opts: Electron.ClientRequestConstructorOptions): string {
  if (opts.url) return opts.url;
  const host = opts.host ?? (opts.hostname ? `${opts.hostname}${opts.port ? `:${opts.port}` : ''}` : '');
  if (!host) return '';
  const protocol = opts.protocol ?? 'http:';
  const path = opts.path ?? '/';
  return `${protocol}//${host}${path}`;
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

// Merge injected trace headers with the app's request headers. HTTP header names are case-insensitive
// and net.request headers are a plain record with app-controlled casing, so an injected carrier header
// (always lowercase) must not be added when the app already set the same header under a different
// casing (e.g. app `Traceparent` vs carrier `traceparent`) — that would send two trace contexts and
// break propagation. App headers take precedence. (The fetch path normalizes via toRecord/Headers, so
// it does not need this.)
function mergeHeaders<T extends string | string[]>(
  carrier: Record<string, string>,
  existing: Record<string, T>
): Record<string, string | T> {
  const existingNames = new Set(Object.keys(existing).map((name) => name.toLowerCase()));
  const merged: Record<string, string | T> = { ...existing };
  for (const [name, value] of Object.entries(carrier)) {
    if (!existingNames.has(name.toLowerCase())) {
      merged[name] = value;
    }
  }
  return merged;
}
