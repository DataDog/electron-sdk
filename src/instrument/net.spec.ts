import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { EventEmitter } from 'node:events';

const mockSpan = { setTag: vi.fn(), finish: vi.fn() };
const mockDdTrace = {
  startSpan: vi.fn(() => mockSpan),
  inject: vi.fn((_, __, carrier: Record<string, string>) => {
    carrier['x-datadog-trace-id'] = '123';
  }),
  scope: vi.fn(() => ({ activate: vi.fn((_, fn: () => unknown) => fn()) })),
};

vi.mock('dd-trace', () => ({ default: mockDdTrace }));

type RequestListener = (...args: unknown[]) => void;

function makeResponse(statusCode = 200): EventEmitter & { statusCode: number } {
  const listeners: Record<string, ((...a: unknown[]) => void)[]> = {};
  return {
    statusCode,
    on(event: string, fn: (...a: unknown[]) => void) {
      (listeners[event] ??= []).push(fn);
      return this;
    },
    emit(event: string, ...args: unknown[]) {
      listeners[event]?.forEach((fn) => fn(...args));
    },
  } as unknown as EventEmitter & { statusCode: number };
}

function makeRequest() {
  const listeners: Record<string, RequestListener[]> = {};
  return {
    on(event: string, fn: RequestListener) {
      (listeners[event] ??= []).push(fn);
      return this;
    },
    emit(event: string, ...args: unknown[]) {
      listeners[event]?.forEach((fn) => fn(...args));
    },
    end: vi.fn(),
  };
}

describe('patchNet', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mockDdTrace.inject.mockImplementation((_, __, carrier: Record<string, string>) => {
      carrier['x-datadog-trace-id'] = '123';
    });
  });

  function makeMockNet(req = makeRequest()) {
    return {
      request: vi.fn(() => req),
    };
  }

  it('starts an http.request span with correct tags', async () => {
    const { patchNet } = await import('./net');
    const req = makeRequest();
    const net = makeMockNet(req);
    patchNet(net as unknown as Electron.Net);

    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-explicit-any
    (net.request as any)({ url: 'https://example.com/path', method: 'POST' });

    expect(mockDdTrace.startSpan).toHaveBeenCalledWith(
      'http.request',
      expect.objectContaining({
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        tags: expect.objectContaining({
          'span.kind': 'client',
          'span.type': 'http',
          component: 'electron',
          'http.method': 'POST',
          'http.url': 'https://example.com/path',
        }),
      })
    );
  });

  it('defaults method to GET when not specified', async () => {
    const { patchNet } = await import('./net');
    const net = makeMockNet();
    patchNet(net as unknown as Electron.Net);

    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-explicit-any
    (net.request as any)({ url: 'https://example.com' });

    expect(mockDdTrace.startSpan).toHaveBeenCalledWith(
      'http.request',
      expect.objectContaining({
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        tags: expect.objectContaining({ 'http.method': 'GET' }),
      })
    );
  });

  it('handles string URL option', async () => {
    const { patchNet } = await import('./net');
    const net = makeMockNet();
    patchNet(net as unknown as Electron.Net);

    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-explicit-any
    (net.request as any)('https://example.com');

    expect(mockDdTrace.startSpan).toHaveBeenCalledWith(
      'http.request',
      expect.objectContaining({
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        tags: expect.objectContaining({ 'http.url': 'https://example.com' }),
      })
    );
  });

  it('injects trace headers into request options', async () => {
    const { patchNet } = await import('./net');
    const req = makeRequest();
    const net = makeMockNet(req);
    const originalRequest = net.request;
    patchNet(net as unknown as Electron.Net);

    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-explicit-any
    (net.request as any)({ url: 'https://example.com' });

    const [opts] = originalRequest.mock.calls[0] as unknown as [Electron.ClientRequestConstructorOptions];
    expect(opts.headers?.['x-datadog-trace-id']).toBe('123');
  });

  it('preserves existing headers and does not overwrite them', async () => {
    const { patchNet } = await import('./net');
    const net = makeMockNet();
    const originalRequest = net.request;
    patchNet(net as unknown as Electron.Net);

    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-explicit-any
    (net.request as any)({
      url: 'https://example.com',
      headers: { 'x-datadog-trace-id': 'existing' },
    });

    const [opts] = originalRequest.mock.calls[0] as unknown as [Electron.ClientRequestConstructorOptions];
    expect(opts.headers?.['x-datadog-trace-id']).toBe('existing');
  });

  it('sets http.status_code tag and finishes span on response end', async () => {
    const { patchNet } = await import('./net');
    const req = makeRequest();
    const net = makeMockNet(req);
    patchNet(net as unknown as Electron.Net);

    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-explicit-any
    (net.request as any)({ url: 'https://example.com' });

    const response = makeResponse(201);
    req.emit('response', response);
    response.emit('end');

    expect(mockSpan.setTag).toHaveBeenCalledWith('http.status_code', '201');
    expect(mockSpan.finish).toHaveBeenCalledTimes(1);
  });

  it('finishes span with error tag on response error', async () => {
    const { patchNet } = await import('./net');
    const req = makeRequest();
    const net = makeMockNet(req);
    patchNet(net as unknown as Electron.Net);

    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-explicit-any
    (net.request as any)({ url: 'https://example.com' });

    const response = makeResponse();
    req.emit('response', response);
    const err = new Error('connection reset');
    response.emit('error', err);

    expect(mockSpan.setTag).toHaveBeenCalledWith('error', err);
    expect(mockSpan.finish).toHaveBeenCalledTimes(1);
  });

  it('finishes span with error tag on request error', async () => {
    const { patchNet } = await import('./net');
    const req = makeRequest();
    const net = makeMockNet(req);
    patchNet(net as unknown as Electron.Net);

    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-explicit-any
    (net.request as any)({ url: 'https://example.com' });

    const err = new Error('ECONNREFUSED');
    req.emit('error', err);

    expect(mockSpan.setTag).toHaveBeenCalledWith('error', err);
    expect(mockSpan.finish).toHaveBeenCalledTimes(1);
  });

  it('finishes span on request abort', async () => {
    const { patchNet } = await import('./net');
    const req = makeRequest();
    const net = makeMockNet(req);
    patchNet(net as unknown as Electron.Net);

    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-explicit-any
    (net.request as any)({ url: 'https://example.com' });

    req.emit('abort');

    expect(mockSpan.finish).toHaveBeenCalledTimes(1);
  });

  it('finishes span at most once (finish-once guard)', async () => {
    const { patchNet } = await import('./net');
    const req = makeRequest();
    const net = makeMockNet(req);
    patchNet(net as unknown as Electron.Net);

    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-explicit-any
    (net.request as any)({ url: 'https://example.com' });

    req.emit('error', new Error('fail'));
    req.emit('abort');
    req.emit('error', new Error('fail again'));

    expect(mockSpan.finish).toHaveBeenCalledTimes(1);
  });
});
