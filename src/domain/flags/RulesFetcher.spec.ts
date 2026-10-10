import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import { display } from '../../tools/display';
import * as rulesBased from '@datadog/openfeature-browser/rules-based';
import { fixtureWire } from '../../common/flags/evaluationCases.specUtil';

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
import { RulesFetcher, MAX_CONFIGURATION_LENGTH } from './RulesFetcher';

const rulesJSON = JSON.parse(fixtureWire) as { rules: { response: string } };
const rulesBinary = Uint8Array.from(atob(rulesJSON.rules.response), (c) => c.charCodeAt(0));

type FakeFetch = typeof fetch & { calls: { url: string; init: RequestInit }[] };

const wireResponseOf = (wire: string) => (JSON.parse(wire) as { rules: { response: string } }).rules.response;

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

const okResponse = (body: ArrayBuffer | string): Response =>
  new Response(body, { status: 200, headers: { 'content-type': 'application/protobuf' } });
const errorResponse = (status: number, detail: string): Response =>
  new Response(JSON.stringify({ errors: [{ detail }] }), {
    status,
    headers: { 'content-type': 'application/vnd.api+json' },
  });

describe('RulesFetcher', () => {
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

  function createFetcher(overrides: Partial<ConstructorParameters<typeof RulesFetcher>[0]> = {}) {
    return new RulesFetcher({
      clientToken: 'client-token',
      site: 'datadoghq.com',
      env: 'e2e',
      fetchTimeout: 5000,
      maxConfigurationLength: MAX_CONFIGURATION_LENGTH,
      ...overrides,
    });
  }

  it('resolves a successful fetch with the serialized wire and sends the client token', async () => {
    const fakeFetch = makeFakeFetch(() => Promise.resolve(okResponse(rulesBinary.buffer.slice(0))));
    const fetcher = createFetcher({ fetch: fakeFetch });
    const outcome = await fetcher.fetch();
    expect(outcome).toMatchObject({ kind: 'success' });
    if (outcome.kind === 'success') {
      expect(wireResponseOf(outcome.wire)).toBe(rulesJSON.rules.response);
    }
    expect(fakeFetch.calls[0].url).toBe(
      'https://ufc-client.ff-cdn.datadoghq.com/api/v2/feature-flagging/config/rules-based/client?dd_env=e2e'
    );
    expect(fakeFetch.calls[0].init.headers).toMatchObject({ 'dd-client-token': 'client-token' });
  });

  it('aborts after fetchTimeout and resolves as a warm failure', async () => {
    const fakeFetch = makeFakeFetch(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
        })
    );
    const fetcher = createFetcher({ fetch: fakeFetch, fetchTimeout: 5000 });
    const outcomePromise = fetcher.fetch();
    const assertion = outcomePromise.then((outcome) => expect(outcome).toMatchObject({ kind: 'warm-failure' }));
    await vi.advanceTimersByTimeAsync(5001);
    await assertion;
  });

  it('classifies network errors and HTTP 5xx as warm failures', async () => {
    const networkErrorFetch = makeFakeFetch(() => Promise.reject(new TypeError('fetch failed')));
    expect(await createFetcher({ fetch: networkErrorFetch }).fetch()).toMatchObject({ kind: 'warm-failure' });

    const serverErrorFetch = makeFakeFetch(() => Promise.resolve(errorResponse(503, 'internal error')));
    displayWarnSpy.mockClear();
    expect(await createFetcher({ fetch: serverErrorFetch }).fetch()).toMatchObject({ kind: 'warm-failure' });
    expect(displayWarnSpy).toHaveBeenCalledTimes(1);
  });

  it('maps authoritative failures (HTTP 4xx) to an actionable display.error once per failure streak', async () => {
    const fakeFetch = makeFakeFetch(() =>
      Promise.resolve(errorResponse(403, 'Allow local rule evaluation in client SDKs is disabled'))
    );
    const fetcher = createFetcher({ fetch: fakeFetch });
    expect(await fetcher.fetch()).toMatchObject({ kind: 'authoritative-failure' });
    expect(await fetcher.fetch()).toMatchObject({ kind: 'authoritative-failure' });
    expect(displayErrorSpy).toHaveBeenCalledTimes(1);
    expect(displayErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Allow local rule evaluation in client SDKs'));
    expect(displayErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Client'));

    // A success resets the streak: the next failure logs again.
    const successFetch = makeFakeFetch(() => Promise.resolve(okResponse(rulesBinary.buffer.slice(0))));
    const fetcher2 = createFetcher({ fetch: successFetch });
    await fetcher2.fetch();
    const failingFetch = makeFakeFetch(() => Promise.resolve(errorResponse(403, 'off')));
    const fetcher3 = createFetcher({ fetch: failingFetch });
    await fetcher3.fetch();
    expect(displayErrorSpy).toHaveBeenCalledTimes(2);
  });

  it('treats a configuration longer than the configured maximum as a failure and keeps the previous one', async () => {
    const fakeFetch = makeFakeFetch(() => Promise.resolve(okResponse(rulesBinary.buffer.slice(0))));
    const fetcher = createFetcher({ fetch: fakeFetch, maxConfigurationLength: 10 });
    const outcome = await fetcher.fetch();
    expect(outcome).toMatchObject({ kind: 'oversize' });
    expect(displayErrorSpy).toHaveBeenCalledTimes(1);
  });

  it('passes flaggingProxy through to the upstream fetch', async () => {
    const fakeFetch = makeFakeFetch(() => Promise.resolve(okResponse(rulesBinary.buffer.slice(0))));
    await createFetcher({ fetch: fakeFetch, flaggingProxy: 'http://localhost:9222' }).fetch();
    expect(fakeFetch.calls[0].url).toBe('http://localhost:9222/?dd_env=e2e');
  });

  it('ignores a response older than the latest applied request', async () => {
    const resolvers: ((response: Response) => void)[] = [];
    const hangingFetch = makeFakeFetch(() => new Promise<Response>((resolve) => resolvers.push(resolve)));
    const fetcher = createFetcher({ fetch: hangingFetch });
    const first = fetcher.fetch();
    const second = fetcher.fetch();
    resolvers[0](okResponse(rulesBinary.buffer.slice(0)));
    resolvers[1](okResponse(rulesBinary.buffer.slice(0)));
    expect(await first).toMatchObject({ kind: 'superseded' });
    expect(await second).toMatchObject({ kind: 'success' });
  });

  it('reports serialization errors through telemetry and keeps serving', async () => {
    const fakeFetch = makeFakeFetch(() => Promise.resolve(okResponse(rulesBinary.buffer.slice(0))));
    vi.spyOn(rulesBased, 'configurationToString').mockImplementationOnce(() => {
      throw new Error('serialize error');
    });
    const fetcher = createFetcher({ fetch: fakeFetch });
    const outcome = await fetcher.fetch();
    expect(outcome).toMatchObject({ kind: 'warm-failure' });
    expect(addErrorMock).toHaveBeenCalled();
  });
  it('classifies a rulesError configuration as an authoritative failure, never a success', async () => {
    vi.spyOn(rulesBased, 'fetchRulesConfiguration').mockResolvedValueOnce({
      rulesError: 'Rules-based evaluation is disabled for this organization',
    });
    const outcome = await createFetcher().fetch();
    expect(outcome).toMatchObject({ kind: 'authoritative-failure' });
    expect(displayErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Allow local rule evaluation in client SDKs'));
  });

  it('classifies a decoded configuration without rules as a warm failure, never a success', async () => {
    vi.spyOn(rulesBased, 'fetchRulesConfiguration').mockResolvedValueOnce({});
    const outcome = await createFetcher().fetch();
    expect(outcome).toMatchObject({ kind: 'warm-failure' });
    expect(displayErrorSpy).not.toHaveBeenCalled();
  });

  it('classifies an undecodable 2xx response as a warm failure without telemetry', async () => {
    const fakeFetch = makeFakeFetch(() => Promise.resolve(okResponse('not protobuf at all')));
    const outcome = await createFetcher({ fetch: fakeFetch }).fetch();
    expect(outcome).toMatchObject({ kind: 'warm-failure' });
    expect(addErrorMock).not.toHaveBeenCalled();
    expect(displayWarnSpy).toHaveBeenCalledTimes(1);
  });

  it('promise callbacks are monitored: an error thrown in a callback reaches telemetry, not the host', async () => {
    const monitorErrors: unknown[] = [];
    startMonitorErrorCollection((error: unknown) => monitorErrors.push(error));
    displayWarnSpy.mockImplementation(() => {
      throw new Error('callback failure');
    });
    const failingFetch = makeFakeFetch(() => Promise.reject(new TypeError('fetch failed')));
    try {
      await expect(createFetcher({ fetch: failingFetch }).fetch()).resolves.toMatchObject({ kind: 'warm-failure' });
      expect(monitorErrors).toEqual([expect.objectContaining({ message: 'callback failure' })]);
    } finally {
      startMonitorErrorCollection(() => undefined);
    }
  });
});
