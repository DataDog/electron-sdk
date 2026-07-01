import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { EventEmitter } from 'node:events';

const mockSpan = { setTag: vi.fn(), finish: vi.fn() };
const mockActiveSpan = { id: 'active-span' };
const mockScope = {
  activate: vi.fn((_: unknown, fn: () => unknown) => fn()),
  active: vi.fn(() => null as typeof mockActiveSpan | null),
};
const mockDdTrace = {
  startSpan: vi.fn(() => mockSpan),
  inject: vi.fn((_, __, carrier: Record<string, string>) => {
    carrier['x-datadog-trace-id'] = '123';
  }),
  scope: vi.fn(() => mockScope),
};

vi.mock('../entries/instrument-prelude', () => ({ default: mockDdTrace }));

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

  async function setupNet(req = makeRequest()) {
    const { patchNet } = await import('./net');
    const originalRequest = vi.fn(() => req);
    const patchedNet = { request: originalRequest } as unknown as Electron.Net;
    patchNet(patchedNet);
    return { patchedNet, originalRequest, req };
  }

  async function setupNetWithFetch(fetchImpl?: () => Promise<Response>) {
    const { patchNet } = await import('./net');
    const originalFetch = vi.fn(fetchImpl ?? (() => Promise.resolve({ status: 200, ok: true } as Response)));
    const originalRequest = vi.fn(() => makeRequest());
    const patchedNet = { request: originalRequest, fetch: originalFetch } as unknown as Electron.Net;
    patchNet(patchedNet);
    return { patchedNet, originalFetch, originalRequest };
  }

  it('passes the active span as childOf', async () => {
    mockScope.active.mockReturnValue(mockActiveSpan);
    const { patchedNet } = await setupNet();

    patchedNet.request({ url: 'https://example.com' });

    expect(mockDdTrace.startSpan).toHaveBeenCalledWith(
      'http.request',
      expect.objectContaining({ childOf: mockActiveSpan })
    );
  });

  it('passes undefined childOf when no active span', async () => {
    mockScope.active.mockReturnValue(null);
    const { patchedNet } = await setupNet();

    patchedNet.request({ url: 'https://example.com' });

    expect(mockDdTrace.startSpan).toHaveBeenCalledWith('http.request', expect.objectContaining({ childOf: undefined }));
  });

  it('starts an http.request span with correct tags', async () => {
    const { patchedNet } = await setupNet();

    patchedNet.request({ url: 'https://example.com/path', method: 'POST' });

    expect(mockDdTrace.startSpan).toHaveBeenCalledWith(
      'http.request',
      expect.objectContaining({
        tags: expect.objectContaining({
          'span.kind': 'client',
          'span.type': 'http',
          component: 'electron',
          'http.method': 'POST',
          'http.url': 'https://example.com/path',
        }) as unknown,
      })
    );
  });

  it('defaults method to GET when not specified', async () => {
    const { patchedNet } = await setupNet();

    patchedNet.request({ url: 'https://example.com' });

    expect(mockDdTrace.startSpan).toHaveBeenCalledWith(
      'http.request',
      expect.objectContaining({
        tags: expect.objectContaining({ 'http.method': 'GET' }) as unknown,
      })
    );
  });

  it('handles string URL option', async () => {
    const { patchedNet } = await setupNet();

    patchedNet.request('https://example.com');

    expect(mockDdTrace.startSpan).toHaveBeenCalledWith(
      'http.request',
      expect.objectContaining({
        tags: expect.objectContaining({ 'http.url': 'https://example.com' }) as unknown,
      })
    );
  });

  it('injects trace headers into request options', async () => {
    const { patchedNet, originalRequest } = await setupNet();

    patchedNet.request({ url: 'https://example.com' });

    const [opts] = originalRequest.mock.calls[0] as unknown as [Electron.ClientRequestConstructorOptions];
    expect(opts.headers?.['x-datadog-trace-id']).toBe('123');
  });

  it('preserves existing headers and does not overwrite them', async () => {
    const { patchedNet, originalRequest } = await setupNet();

    patchedNet.request({ url: 'https://example.com', headers: { 'x-datadog-trace-id': 'existing' } });

    const [opts] = originalRequest.mock.calls[0] as unknown as [Electron.ClientRequestConstructorOptions];
    expect(opts.headers?.['x-datadog-trace-id']).toBe('existing');
  });

  it('sets http.status_code tag and finishes span on response end', async () => {
    const { patchedNet, req } = await setupNet();

    patchedNet.request({ url: 'https://example.com' });

    const response = makeResponse(201);
    req.emit('response', response);
    response.emit('end');

    expect(mockSpan.setTag).toHaveBeenCalledWith('http.status_code', '201');
    expect(mockSpan.finish).toHaveBeenCalledTimes(1);
  });

  it('finishes span with error tag on response error', async () => {
    const { patchedNet, req } = await setupNet();

    patchedNet.request({ url: 'https://example.com' });

    const response = makeResponse();
    req.emit('response', response);
    response.emit('error', new Error('connection reset'));

    expect(mockSpan.setTag).toHaveBeenCalledWith('error', expect.any(Error));
    expect(mockSpan.finish).toHaveBeenCalledTimes(1);
  });

  it('finishes span with error tag on request error', async () => {
    const { patchedNet, req } = await setupNet();

    patchedNet.request({ url: 'https://example.com' });

    req.emit('error', new Error('ECONNREFUSED'));

    expect(mockSpan.setTag).toHaveBeenCalledWith('error', expect.any(Error));
    expect(mockSpan.finish).toHaveBeenCalledTimes(1);
  });

  it('finishes span on request abort', async () => {
    const { patchedNet, req } = await setupNet();

    patchedNet.request({ url: 'https://example.com' });
    req.emit('abort');

    expect(mockSpan.finish).toHaveBeenCalledTimes(1);
  });

  it('finishes span at most once (finish-once guard)', async () => {
    const { patchedNet, req } = await setupNet();

    patchedNet.request({ url: 'https://example.com' });
    req.emit('error', new Error('fail'));
    req.emit('abort');
    req.emit('error', new Error('fail again'));

    expect(mockSpan.finish).toHaveBeenCalledTimes(1);
  });

  it('sets error tag and finishes span when originalRequest throws synchronously', async () => {
    const { patchNet } = await import('./net');
    const err = new Error('invalid options');
    const originalRequest = vi.fn(() => {
      throw err;
    });
    const patchedNet = { request: originalRequest } as unknown as Electron.Net;
    patchNet(patchedNet);

    expect(() => patchedNet.request({ url: 'https://example.com' })).toThrow(err);
    expect(mockSpan.setTag).toHaveBeenCalledWith('error', err);
    expect(mockSpan.finish).toHaveBeenCalledTimes(1);
  });

  describe('net.fetch', () => {
    it('passes the active span as childOf', async () => {
      mockScope.active.mockReturnValue(mockActiveSpan);
      const { patchedNet } = await setupNetWithFetch();

      await patchedNet.fetch('https://example.com');

      expect(mockDdTrace.startSpan).toHaveBeenCalledWith(
        'http.request',
        expect.objectContaining({ childOf: mockActiveSpan })
      );
    });

    it('starts an http.request span with correct tags', async () => {
      const { patchedNet } = await setupNetWithFetch();

      await patchedNet.fetch('https://example.com/path');

      expect(mockDdTrace.startSpan).toHaveBeenCalledWith(
        'http.request',
        expect.objectContaining({
          tags: expect.objectContaining({
            'span.kind': 'client',
            'span.type': 'http',
            component: 'electron',
            'http.method': 'GET',
            'http.url': 'https://example.com/path',
          }) as unknown,
        })
      );
    });

    it('extracts method from init', async () => {
      const { patchedNet } = await setupNetWithFetch();

      await patchedNet.fetch('https://example.com', { method: 'POST' });

      expect(mockDdTrace.startSpan).toHaveBeenCalledWith(
        'http.request',
        expect.objectContaining({
          tags: expect.objectContaining({ 'http.method': 'POST' }) as unknown,
        })
      );
    });

    it('extracts method from Request object', async () => {
      const { patchedNet } = await setupNetWithFetch();

      await patchedNet.fetch({ url: 'https://example.com', method: 'DELETE' } as unknown as Request);

      expect(mockDdTrace.startSpan).toHaveBeenCalledWith(
        'http.request',
        expect.objectContaining({
          tags: expect.objectContaining({ 'http.method': 'DELETE' }) as unknown,
        })
      );
    });

    it('injects trace headers into patchedInit', async () => {
      const { patchedNet, originalFetch } = await setupNetWithFetch();

      await patchedNet.fetch('https://example.com');

      const [, patchedInit] = originalFetch.mock.calls[0] as unknown as [string, RequestInit];
      expect((patchedInit.headers as Record<string, string>)?.['x-datadog-trace-id']).toBe('123');
    });

    it('preserves existing headers and does not overwrite them', async () => {
      const { patchedNet, originalFetch } = await setupNetWithFetch();

      await patchedNet.fetch('https://example.com', { headers: { 'x-datadog-trace-id': 'existing' } });

      const [, patchedInit] = originalFetch.mock.calls[0] as unknown as [string, RequestInit];
      expect((patchedInit.headers as Record<string, string>)?.['x-datadog-trace-id']).toBe('existing');
    });

    it.each<{ form: string; headers: HeadersInit }>([
      { form: 'plain record', headers: { authorization: 'token' } },
      { form: 'array of tuples', headers: [['authorization', 'token']] },
      { form: 'Headers instance', headers: new Headers({ authorization: 'token' }) },
    ])('preserves init.headers passed as a $form alongside the carrier', async ({ headers }) => {
      const { patchedNet, originalFetch } = await setupNetWithFetch();

      await patchedNet.fetch('https://example.com', { headers });

      const [, patchedInit] = originalFetch.mock.calls[0] as unknown as [string, RequestInit];
      const result = patchedInit.headers as Record<string, string>;
      expect(result.authorization).toBe('token');
      expect(result['x-datadog-trace-id']).toBe('123');
    });

    it('normalizes header keys to lowercase (Headers semantics)', async () => {
      const { patchedNet, originalFetch } = await setupNetWithFetch();

      await patchedNet.fetch('https://example.com', { headers: { Authorization: 'token' } });

      const [, patchedInit] = originalFetch.mock.calls[0] as unknown as [string, RequestInit];
      const result = patchedInit.headers as Record<string, string>;
      expect(result.authorization).toBe('token');
      expect(result.Authorization).toBeUndefined();
    });

    it('combines duplicate header keys like a real Headers object', async () => {
      const { patchedNet, originalFetch } = await setupNetWithFetch();

      await patchedNet.fetch('https://example.com', {
        headers: [
          ['x-tag', 'a'],
          ['x-tag', 'b'],
        ],
      });

      const [, patchedInit] = originalFetch.mock.calls[0] as unknown as [string, RequestInit];
      const result = patchedInit.headers as Record<string, string>;
      expect(result['x-tag']).toBe('a, b');
    });

    it('preserves headers set on a Request object when no init is passed', async () => {
      const { patchedNet, originalFetch } = await setupNetWithFetch();

      const request = new Request('https://example.com', { headers: { authorization: 'Bearer token' } });
      await patchedNet.fetch(request);

      const [, patchedInit] = originalFetch.mock.calls[0] as unknown as [Request, RequestInit];
      const headers = patchedInit.headers as Record<string, string>;
      expect(headers.authorization).toBe('Bearer token');
      expect(headers['x-datadog-trace-id']).toBe('123');
    });

    it('lets init.headers take precedence over Request headers (matches fetch semantics)', async () => {
      const { patchedNet, originalFetch } = await setupNetWithFetch();

      const request = new Request('https://example.com', { headers: { authorization: 'from-request' } });
      await patchedNet.fetch(request, { headers: { authorization: 'from-init' } });

      const [, patchedInit] = originalFetch.mock.calls[0] as unknown as [Request, RequestInit];
      const headers = patchedInit.headers as Record<string, string>;
      expect(headers.authorization).toBe('from-init');
      expect(headers['x-datadog-trace-id']).toBe('123');
    });

    it('sets http.status_code tag and finishes span on resolve', async () => {
      const { patchedNet } = await setupNetWithFetch(() => Promise.resolve({ status: 201, ok: true } as Response));

      await patchedNet.fetch('https://example.com');

      expect(mockSpan.setTag).toHaveBeenCalledWith('http.status_code', '201');
      expect(mockSpan.finish).toHaveBeenCalledTimes(1);
    });

    it('sets error tag and finishes span on reject', async () => {
      const err = new Error('network error');
      const { patchedNet } = await setupNetWithFetch(() => Promise.reject(err));

      await patchedNet.fetch('https://example.com').catch(() => null);

      expect(mockSpan.setTag).toHaveBeenCalledWith('error', err);
      expect(mockSpan.finish).toHaveBeenCalledTimes(1);
    });

    it('sets error tag and finishes span when originalFetch throws synchronously', async () => {
      const err = new Error('sync fetch boom');
      const { patchedNet } = await setupNetWithFetch(() => {
        throw err;
      });

      expect(() => patchedNet.fetch('https://example.com')).toThrow(err);
      expect(mockSpan.setTag).toHaveBeenCalledWith('error', err);
      expect(mockSpan.finish).toHaveBeenCalledTimes(1);
    });

    it('does not create a span for net.request called internally by net.fetch', async () => {
      // Simulate net.fetch internally calling net.request (as real Electron does).
      // patchedNet is captured via closure — valid because fetch is only called after patchNet runs.
      const { patchNet } = await import('./net');
      const originalRequest = vi.fn(() => makeRequest());
      const originalFetch = vi.fn(() => {
        patchedNet.request({ url: 'https://example.com' });
        return Promise.resolve({ status: 200, ok: true } as Response);
      });
      const patchedNet = { request: originalRequest, fetch: originalFetch } as unknown as Electron.Net;
      patchNet(patchedNet);

      await patchedNet.fetch('https://example.com');

      // Only one span — from net.fetch wrapper; internal net.request call is suppressed
      expect(mockDdTrace.startSpan).toHaveBeenCalledTimes(1);
    });

    it('skips net.fetch patching when net.fetch is not present', async () => {
      const { patchedNet } = await setupNet();
      expect(mockDdTrace.startSpan).not.toHaveBeenCalled();

      patchedNet.request({ url: 'https://example.com' });
      expect(mockDdTrace.startSpan).toHaveBeenCalledTimes(1);
    });
  });
});
