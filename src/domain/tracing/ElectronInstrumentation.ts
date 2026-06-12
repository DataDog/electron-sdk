import ddTrace from 'dd-trace';
import { tracingChannel, channel } from 'node:diagnostics_channel';
import type { TracingChannelSubscribers } from 'node:diagnostics_channel';

type Span = ReturnType<typeof ddTrace.startSpan>;

function getTracer(): typeof ddTrace {
  return ddTrace;
}

interface IpcContext {
  args: unknown[];
  channel: string;
  self?: object;
  event?: unknown;
  span?: Span;
  error?: unknown;
  result?: unknown;
}

interface NetRequestOptions {
  url?: string;
  method?: string;
  headers?: Record<string, string | string[]>;
  [key: string]: unknown;
}

interface NetContext {
  args: [string | NetRequestOptions, ...unknown[]];
  span?: Span;
  res?: { _responseHead?: { statusCode?: number } };
  error?: unknown;
  result?: unknown;
}

const mainReceiveCh = tracingChannel<IpcContext>('apm:electron:ipc:main:receive');
const mainHandleCh = tracingChannel<IpcContext>('apm:electron:ipc:main:handle');
const mainSendCh = tracingChannel<IpcContext>('apm:electron:ipc:main:send');
const rendererPatchedCh = channel('apm:electron:ipc:renderer:patched');
const rendererReceiveCh = tracingChannel<IpcContext>('apm:electron:ipc:renderer:receive');
const rendererSendCh = tracingChannel<IpcContext>('apm:electron:ipc:renderer:send');
const requestCh = tracingChannel<NetContext>('apm:electron:net:request');

// eslint-disable-next-line @typescript-eslint/no-empty-function
function noop(): void {}

export class ElectronInstrumentation {
  private renderers = new WeakSet<object>();

  private mainReceiveHandlers: TracingChannelSubscribers<IpcContext>;
  private mainHandleHandlers: TracingChannelSubscribers<IpcContext>;
  private mainSendHandlers: TracingChannelSubscribers<IpcContext>;
  private rendererPatchedHandler: (data: unknown) => void;
  private rendererReceiveHandlers: TracingChannelSubscribers<IpcContext>;
  private rendererSendHandlers: TracingChannelSubscribers<IpcContext>;
  private requestHandlers: TracingChannelSubscribers<NetContext>;

  constructor() {
    this.mainReceiveHandlers = this.makeReceiveHandlers('electron.main.receive');
    this.mainHandleHandlers = this.makeReceiveHandlers('electron.main.handle');
    this.rendererReceiveHandlers = this.makeReceiveHandlers('electron.renderer.receive');

    this.mainSendHandlers = this.makeSendHandlers(
      'electron.main.send',
      (ctx) => ctx.self !== undefined && this.renderers.has(ctx.self)
    );
    this.rendererSendHandlers = this.makeSendHandlers('electron.renderer.send', () => true);

    this.rendererPatchedHandler = (event: unknown) => {
      if (event && typeof event === 'object' && 'sender' in event) {
        this.renderers.add(event.sender as object);
      }
    };

    this.requestHandlers = this.makeRequestHandlers();

    mainReceiveCh.subscribe(this.mainReceiveHandlers);
    mainHandleCh.subscribe(this.mainHandleHandlers);
    mainSendCh.subscribe(this.mainSendHandlers);
    rendererPatchedCh.subscribe(this.rendererPatchedHandler);
    rendererReceiveCh.subscribe(this.rendererReceiveHandlers);
    rendererSendCh.subscribe(this.rendererSendHandlers);
    requestCh.subscribe(this.requestHandlers);
  }

  stop(): void {
    mainReceiveCh.unsubscribe(this.mainReceiveHandlers);
    mainHandleCh.unsubscribe(this.mainHandleHandlers);
    mainSendCh.unsubscribe(this.mainSendHandlers);
    rendererPatchedCh.unsubscribe(this.rendererPatchedHandler);
    rendererReceiveCh.unsubscribe(this.rendererReceiveHandlers);
    rendererSendCh.unsubscribe(this.rendererSendHandlers);
    requestCh.unsubscribe(this.requestHandlers);
  }

  private makeReceiveHandlers(spanName: string): TracingChannelSubscribers<IpcContext> {
    return {
      start: (ctx: IpcContext) => {
        if (ctx.channel?.startsWith('datadog:')) return;

        const tracer = getTracer();
        const childOf = tracer.extract('text_map', ctx.args[ctx.args.length - 1] as object);
        if (childOf) ctx.args.pop();

        const span = tracer.startSpan(spanName, {
          childOf,
          tags: {
            'span.kind': 'consumer',
            component: 'electron',
            'resource.name': ctx.channel,
            type: 'worker',
          },
        });

        ctx.span = span;
      },
      end: noop,
      asyncStart: noop,
      asyncEnd: (ctx: IpcContext) => {
        ctx.span?.finish();
      },
      error: (ctx: IpcContext) => {
        ctx.span?.setTag('error', ctx.error);
      },
    };
  }

  private makeSendHandlers(
    spanName: string,
    shouldInject: (ctx: IpcContext) => boolean
  ): TracingChannelSubscribers<IpcContext> {
    return {
      start: (ctx: IpcContext) => {
        if (ctx.channel?.startsWith('datadog:')) return;

        const tracer = getTracer();
        const span = tracer.startSpan(spanName, {
          tags: {
            'span.kind': 'producer',
            component: 'electron',
            'resource.name': ctx.channel,
          },
        });

        ctx.span = span;

        if (shouldInject(ctx)) {
          const carrier: Record<string, string> = {};
          tracer.inject(span, 'text_map', carrier);
          ctx.args.push(carrier);
        }
      },
      end: (ctx: IpcContext) => {
        if (Object.prototype.hasOwnProperty.call(ctx, 'result')) {
          ctx.span?.finish();
        }
      },
      asyncStart: noop,
      asyncEnd: (ctx: IpcContext) => {
        ctx.span?.finish();
      },
      error: (ctx: IpcContext) => {
        ctx.span?.setTag('error', ctx.error);
      },
    };
  }

  private makeRequestHandlers(): TracingChannelSubscribers<NetContext> {
    return {
      start: (ctx: NetContext) => {
        const tracer = getTracer();
        const raw = ctx.args[0];

        let options: NetRequestOptions;
        if (typeof raw === 'string') {
          options = { url: raw };
          ctx.args[0] = options;
        } else if (!raw) {
          options = {};
          ctx.args[0] = options;
        } else {
          options = raw;
        }

        let parsed: URL | undefined;
        try {
          if (options.url) parsed = new URL(options.url);
        } catch {
          // invalid URL, skip
        }

        const method = (options.method ?? parsed?.pathname ?? 'GET').toUpperCase();
        const urlStr = options.url ?? parsed?.href ?? '';

        const span = tracer.startSpan('http.request', {
          tags: {
            'span.kind': 'client',
            'span.type': 'http',
            component: 'electron',
            'resource.name': method,
            'http.method': method,
            'http.url': urlStr,
          },
        });

        ctx.span = span;

        const carrier: Record<string, string> = {};
        tracer.inject(span, 'http_headers', carrier);
        const headers: Record<string, string | string[]> = options.headers ?? {};
        options.headers = headers;
        for (const name of Object.keys(carrier)) {
          if (!headers[name]) {
            headers[name] = carrier[name];
          }
        }
      },
      end: noop,
      asyncStart: (ctx: NetContext) => {
        if (!ctx.span) return;
        const statusCode = ctx.res?._responseHead?.statusCode;
        if (statusCode !== undefined) {
          ctx.span.setTag('http.status_code', String(statusCode));
        }
        ctx.span.finish();
        ctx.span = undefined;
      },
      asyncEnd: noop,
      error: (ctx: NetContext) => {
        ctx.span?.setTag('error', ctx.error);
      },
    };
  }
}
