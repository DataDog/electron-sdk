import ddTrace from 'dd-trace';
import { tracingChannel, channel } from 'node:diagnostics_channel';
import type { TracingChannelSubscribers } from 'node:diagnostics_channel';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getTracer(): any {
  return ddTrace;
}

interface IpcContext {
  args: unknown[];
  channel: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  self?: any;
  event?: unknown;
  span?: unknown;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  currentStore?: any;
  error?: unknown;
  result?: unknown;
}

interface NetContext {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  args: any[];
  span?: unknown;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  res?: any;
  error?: unknown;
  result?: unknown;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  currentStore?: any;
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
      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
      (ctx) => this.renderers.has(ctx.self)
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

        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        const tracer = getTracer();
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
        const childOf = tracer.extract('text_map', ctx.args[ctx.args.length - 1]);
        if (childOf) ctx.args.pop();

        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
        const span = tracer.startSpan(spanName, {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          childOf,
          tags: {
            'span.kind': 'consumer',
            component: 'electron',
            'resource.name': ctx.channel,
            type: 'worker',
          },
        });

        ctx.span = span;
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
        ctx.currentStore = tracer.scope().activate(span);
      },
      end: noop,
      asyncStart: noop,
      asyncEnd: (ctx: IpcContext) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
        (ctx.span as any)?.finish();
      },
      error: (ctx: IpcContext) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
        (ctx.span as any)?.setTag('error', ctx.error);
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

        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        const tracer = getTracer();
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
        const span = tracer.startSpan(spanName, {
          tags: {
            'span.kind': 'producer',
            component: 'electron',
            'resource.name': ctx.channel,
          },
        });

        ctx.span = span;
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
        ctx.currentStore = tracer.scope().activate(span);

        if (shouldInject(ctx)) {
          const carrier: Record<string, string> = {};
          // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
          tracer.inject(span, 'text_map', carrier);
          ctx.args.push(carrier);
        }
      },
      end: (ctx: IpcContext) => {
        if (Object.prototype.hasOwnProperty.call(ctx, 'result')) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
          (ctx.span as any)?.finish();
        }
      },
      asyncStart: noop,
      asyncEnd: (ctx: IpcContext) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
        (ctx.span as any)?.finish();
      },
      error: (ctx: IpcContext) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
        (ctx.span as any)?.setTag('error', ctx.error);
      },
    };
  }

  private makeRequestHandlers(): TracingChannelSubscribers<NetContext> {
    return {
      start: (ctx: NetContext) => {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        const tracer = getTracer();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment
        let options: any = ctx.args[0];

        if (typeof options === 'string') {
          options = ctx.args[0] = { url: options };
        } else if (!options) {
          options = ctx.args[0] = {};
        }

        let parsed: { href?: string; method?: string } | undefined;
        try {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-member-access
          parsed = new URL(options.url ?? options);
        } catch {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          parsed = options;
        }

        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        const method = ((options.method as string | undefined) ?? parsed?.method ?? 'GET').toUpperCase();
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        const urlStr = (options.url as string | undefined) ?? parsed?.href ?? '';

        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
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
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
        ctx.currentStore = tracer.scope().activate(span);

        const carrier: Record<string, string> = {};
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
        tracer.inject(span, 'http_headers', carrier);
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment
        options.headers = options.headers ?? {};
        for (const name of Object.keys(carrier)) {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
          if (!options.headers[name]) {
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
            options.headers[name] = carrier[name];
          }
        }
      },
      end: noop,
      asyncStart: (ctx: NetContext) => {
        if (!ctx.span) return;
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        const statusCode = ctx.res?._responseHead?.statusCode as number | undefined;
        if (statusCode !== undefined) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
          (ctx.span as any).setTag('http.status_code', String(statusCode));
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
        (ctx.span as any).finish();
        ctx.span = undefined;
      },
      asyncEnd: noop,
      error: (ctx: NetContext) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
        (ctx.span as any)?.setTag('error', ctx.error);
      },
    };
  }
}
