import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import { display } from '../../tools/display';
import { precomputedConfiguration } from '../../common/flags/precomputedCases.specUtil';

vi.mock('../telemetry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../telemetry')>();
  return {
    ...actual,
    addError: vi.fn(),
  };
});

import { addError } from '../telemetry';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore internal browser-core export, as in Telemetry.ts
import { startMonitorErrorCollection } from '@datadog/browser-core/cjs/tools/monitor';

const addErrorMock = addError as unknown as ReturnType<typeof vi.fn>;
import { PrecomputedFetcher, MAX_CONFIGURATION_LENGTH } from './PrecomputedFetcher';
import type { FlatContext } from '../../common/flags/types';

const context: FlatContext = { targetingKey: 'user-pro', plan: 'pro' };
const otherContext: FlatContext = { targetingKey: 'user-free', plan: 'free' };

/** The JSON body `/precompute-assignments` returns for the fixture assignments. */
const assignmentsBody = JSON.stringify(
  (precomputedConfiguration as { precomputed: { response: unknown } }).precomputed.response
);

type FakeFetch = typeof fetch & { calls: { url: string; init: RequestInit }[] };

function makeFakeFetch(handler: (url: string, init: RequestInit) => Promise<Response>): FakeFetch {
  const fake = ((url: string | URL | Request, init: RequestInit = {}) => {
    const href = url as string;
    const result = handler(href, init);
    fake.calls.push({ url: href, init });
    return result;
  }) as unknown as FakeFetch;
  fake.calls = [];
  return fake;
}

const okResponse = (body: string): Response =>
  new Response(body, { status: 200, headers: { 'content-type': 'application/vnd.api+json' } });
const errorResponse = (status: number, detail: string): Response =>
  new Response(JSON.stringify({ errors: [{ detail }] }), {
    status,
    headers: { 'content-type': 'application/vnd.api+json' },
  });

/** A fetch that never resolves on its own and rejects when the SDK aborts its signal. */
const hangFetch: typeof fetch = (url, init) =>
  new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
  }) as never;

describe('PrecomputedFetcher', () => {
  let displayErrorSpy: MockInstance;
  let displayWarnSpy: MockInstance;

  beforeEach(() => {
    vi.useFakeTimers();
    displayErrorSpy = vi.spyOn(display, 'error').mockImplementation(() => undefined);
    displayWarnSpy = vi.spyOn(display, 'warn').mockImplementation(() => undefined);
    addErrorMock.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function createFetcher(overrides: Partial<ConstructorParameters<typeof PrecomputedFetcher>[0]> = {}) {
    return new PrecomputedFetcher({
      clientToken: 'client-token',
      site: 'datadoghq.com',
      env: 'e2e',
      applicationId: 'application-id',
      fetchTimeout: 5000,
      maxConfigurationLength: MAX_CONFIGURATION_LENGTH,
      ...overrides,
    });
  }

  it('sends the normalized context, env, application id and flaggingProxy, and resolves the wire', async () => {
    const fakeFetch = makeFakeFetch(() => Promise.resolve(okResponse(assignmentsBody)));
    const fetcher = createFetcher({ fetch: fakeFetch });
    const outcome = await fetcher.fetch(context);
    expect(outcome).toMatchObject({ kind: 'success', createdAt: '2026-03-04T10:00:00.000Z' });
    if (outcome.kind === 'success') {
      // The wire round-trips the assignments and the context they were computed for.
      const decoded = JSON.parse(outcome.wire) as {
        precomputed: { response: string; context: FlatContext };
      };
      expect(JSON.parse(decoded.precomputed.response)).toEqual(
        (precomputedConfiguration as { precomputed: { response: unknown } }).precomputed.response
      );
      expect(decoded.precomputed.context).toEqual(context);
    }
    expect(fakeFetch.calls).toHaveLength(1);
    const { url, init } = fakeFetch.calls[0];
    expect(url).toContain('/precompute-assignments');
    expect(url).toContain('dd_env=e2e');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({
      'dd-client-token': 'client-token',
      'dd-application-id': 'application-id',
    });
    const body = JSON.parse(String(init.body));
    expect(body.data.attributes.subject.targeting_key).toBe('user-pro');
    expect(body.data.attributes.subject.targeting_attributes).toEqual({ targetingKey: 'user-pro', plan: 'pro' });
    expect(body.data.attributes.env.dd_env).toBe('e2e');

    // The proxy replaces the whole URL (upstream behavior: no path is appended).
    const proxied = makeFakeFetch(() => Promise.resolve(okResponse(assignmentsBody)));
    const proxyFetcher = createFetcher({ fetch: proxied, flaggingProxy: 'flags.example.com' });
    await proxyFetcher.fetch(context);
    expect(proxied.calls[0].url).toBe('https://flags.example.com/?dd_env=e2e');
  });

  it('aborts a superseded request when a newer context is requested', async () => {
    const fetcher = createFetcher({ fetch: hangFetch });
    const first = fetcher.fetch(context);
    const second = fetcher.fetch(otherContext);
    // The newer request also hangs: advance time so both settle through their own abort.
    vi.advanceTimersByTime(5001);
    const outcomes = await Promise.all([first, second]);
    expect(outcomes[0].kind).toBe('superseded');
    // The newer request is the latest one: its outcome is its own abort (transient),
    // never superseded by the older one.
    expect(outcomes[1].kind).toBe('warm-failure');
  });

  it('aborts after fetchTimeout and resolves as a transient failure', async () => {
    const fetcher = createFetcher({ fetchTimeout: 500, fetch: hangFetch });
    const pending = fetcher.fetch(context);
    vi.advanceTimersByTime(501);
    expect(await pending).toEqual({ kind: 'warm-failure' });
    expect(displayWarnSpy).toHaveBeenCalledWith(expect.stringContaining('feature flags'));
  });

  it('classifies transient (5xx, network) and authoritative (4xx, precomputedError) failures distinctly', async () => {
    const transient = createFetcher({
      fetch: () => Promise.resolve(errorResponse(503, 'unavailable')),
    });
    expect(await transient.fetch(context)).toEqual({ kind: 'warm-failure' });

    const network = createFetcher({
      fetch: () => Promise.reject(new TypeError('fetch failed')),
    });
    expect(await network.fetch(context)).toEqual({ kind: 'warm-failure' });

    const authoritative = createFetcher({
      fetch: () => Promise.resolve(errorResponse(403, 'not enabled')),
    });
    expect(await authoritative.fetch(context)).toEqual({ kind: 'authoritative-failure' });
    expect(displayErrorSpy).toHaveBeenCalledTimes(1);
    expect(displayErrorSpy).toHaveBeenCalledWith(expect.stringContaining('feature flags'));

    // A 2xx body the wire parser rejects is a precomputedError (authoritative).
    const invalidBody = createFetcher({
      fetch: () => Promise.resolve(okResponse(JSON.stringify({ data: { type: 'wrong' } }))),
    });
    expect(await invalidBody.fetch(context)).toEqual({ kind: 'authoritative-failure' });
  });

  it('rejects an oversize or undecodable response, keeping the previous configuration', async () => {
    const oversize = createFetcher({
      maxConfigurationLength: 10,
      fetch: () => Promise.resolve(okResponse(assignmentsBody)),
    });
    expect(await oversize.fetch(context)).toEqual({ kind: 'oversize' });
    expect(displayErrorSpy).toHaveBeenCalledWith(expect.stringContaining('maximum size'));

    const undecodable = createFetcher({
      fetch: () => Promise.resolve(okResponse('not json')),
    });
    expect(await undecodable.fetch(context)).toEqual({ kind: 'warm-failure' });
  });

  it('promise callbacks are monitored: a throwing callback reaches telemetry, not the host', async () => {
    const monitorErrors: unknown[] = [];
    startMonitorErrorCollection((error: unknown) => monitorErrors.push(error));
    displayWarnSpy.mockImplementation(() => {
      throw new Error('callback failure');
    });
    const failingFetch = makeFakeFetch(() => Promise.reject(new TypeError('fetch failed')));
    try {
      await expect(createFetcher({ fetch: failingFetch }).fetch(context)).resolves.toMatchObject({
        kind: 'warm-failure',
      });
      expect(monitorErrors).toEqual([expect.objectContaining({ message: 'callback failure' })]);
    } finally {
      startMonitorErrorCollection(() => undefined);
    }
  });

  it('stop() aborts the in-flight fetch and supersedes its outcome', async () => {
    const fetcher = createFetcher({ fetch: hangFetch });
    const pending = fetcher.fetch(context);
    fetcher.stop();
    expect(await pending).toEqual({ kind: 'superseded' });
  });
});
