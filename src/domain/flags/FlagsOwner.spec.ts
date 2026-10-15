import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import { display } from '../../tools/display';
import { configurationToString } from '@datadog/openfeature-browser/rules-based';
import { fixtureWire, fixtureConfiguration } from '../../common/flags/evaluationCases.specUtil';
import { FlagsState } from './FlagsState';
import { AnonymousKeyStore } from './AnonymousKeyStore';
import { RulesFetcher, MAX_CONFIGURATION_LENGTH } from './RulesFetcher';
import { ConfigurationCache } from './ConfigurationCache';
import { FlagsOwner } from './FlagsOwner';

import { addError } from '../telemetry';

vi.mock('node:fs/promises');
vi.mock('../telemetry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../telemetry')>()),
  addError: vi.fn(),
}));

const readFile = vi.mocked(fs.readFile);
const writeFile = vi.mocked(fs.writeFile);
const unlink = vi.mocked(fs.unlink);

const rulesJSON = JSON.parse(fixtureWire) as { rules: { response: string } };
const rulesBinary = Uint8Array.from(atob(rulesJSON.rules.response), (c) => c.charCodeAt(0));

// A second wire where the pro allocation serves the fallback variation.
function secondWire(): string {
  const clone = structuredClone(fixtureConfiguration) as Parameters<typeof configurationToString>[0] & {
    rules: { response: { flags: Record<string, { allocations: { splits: { variationIndex: number }[] }[] }> } };
  };
  clone.rules.response.flags['targeted-flag'].allocations[0].splits[0].variationIndex = 1;
  return configurationToString(clone);
}
const secondJSON = JSON.parse(secondWire()) as { rules: { response: string } };
const secondBinary = Uint8Array.from(atob(secondJSON.rules.response), (c) => c.charCodeAt(0));
const wireResponseOf = (wire: string) => (JSON.parse(wire) as { rules: { response: string } }).rules.response;

const okResponse = (binary: Uint8Array) =>
  new Response(binary.slice().buffer, {
    status: 200,
    headers: { 'content-type': 'application/protobuf' },
  });
const errorResponse = (status: number) =>
  new Response(JSON.stringify({ errors: [{ detail: 'unavailable' }] }), {
    status,
    headers: { 'content-type': 'application/vnd.api+json' },
  });

interface Deferred {
  promise: Promise<Response>;
  resolve: (response: Response) => void;
}

function deferredResponse(): Deferred {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function startOptions(overrides: Partial<Parameters<typeof FlagsOwner.start>[0]> = {}) {
  return {
    refreshInterval: 300000,
    state,
    fetcher,
    cache,
    keyStore,
    ...overrides,
  };
}

async function startAndSettle(options: Parameters<typeof FlagsOwner.start>[0]): Promise<FlagsOwner> {
  const owner = FlagsOwner.start(options);
  await owner.settled();
  return owner;
}

let state: FlagsState;
let fetchHandler: (url: string, init: RequestInit) => Promise<Response>;
let fetcher: RulesFetcher;
let cache: ConfigurationCache;
let keyStore: AnonymousKeyStore;
let cachedEntry: { wire: string; fetchedAt: number } | undefined;

describe('FlagsOwner', () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.spyOn(display, 'warn').mockImplementation(() => undefined);
    vi.spyOn(display, 'error').mockImplementation(() => undefined);
    cachedEntry = undefined;
    readFile.mockImplementation((path: unknown): Promise<string> => {
      const filePath = path as string;
      if (filePath.endsWith('_dd_flags_anonymous_key')) {
        return Promise.resolve('123e4567-e89b-12d3-a456-426614174000');
      }
      if (filePath.includes('/_dd_flags/') && cachedEntry !== undefined) {
        return Promise.resolve(JSON.stringify(cachedEntry));
      }
      const error = new Error('ENOENT') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      return Promise.reject(error);
    });
    writeFile.mockResolvedValue(undefined);
    unlink.mockResolvedValue(undefined);
    state = new FlagsState({ targetingKey: '123e4567-e89b-12d3-a456-426614174000' });
    fetcher = new RulesFetcher({
      clientToken: 'client-token',
      site: 'datadoghq.com',
      env: 'e2e',
      fetchTimeout: 5000,
      maxConfigurationLength: MAX_CONFIGURATION_LENGTH,
      fetch: (url: string | URL | Request, init: RequestInit = {}) => fetchHandler(url as string, init),
    });
    keyStore = await AnonymousKeyStore.init('/userData');
    cache = await ConfigurationCache.init({
      userDataPath: '/userData',
      site: 'datadoghq.com',
      env: 'e2e',
      clientToken: 'client-token',
      persistConfiguration: true,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('fetches on start and becomes READY', async () => {
    fetchHandler = () => Promise.resolve(okResponse(rulesBinary));
    const owner = await startAndSettle(startOptions());
    expect(state.snapshot().status).toBe('READY');
    expect(wireResponseOf(state.snapshot().configuration!)).toBe(rulesJSON.rules.response);
    await owner.stop();
  });

  it('serves the cache as STALE before network, then READY, and persists', async () => {
    cachedEntry = { wire: fixtureWire, fetchedAt: Date.now() - 1000 };
    cache = await ConfigurationCache.init({
      userDataPath: '/userData',
      site: 'datadoghq.com',
      env: 'e2e',
      clientToken: 'client-token',
      persistConfiguration: true,
    });
    const pending = deferredResponse();
    fetchHandler = () => pending.promise;
    const startedOwner = FlagsOwner.start(startOptions());
    await vi.advanceTimersByTimeAsync(0);
    expect(state.snapshot().status).toBe('STALE');
    expect(state.snapshot().configuration).toBe(fixtureWire);
    pending.resolve(okResponse(rulesBinary));
    await startedOwner.settled();
    expect(state.snapshot().status).toBe('READY');
    await vi.advanceTimersByTimeAsync(0);
    const writeCalls = vi.mocked(writeFile).mock.calls as unknown as [path: unknown, data: string][];
    const written = JSON.parse(writeCalls[writeCalls.length - 1][1]) as { wire: string };
    expect(written.wire).toBe(state.snapshot().configuration);
    await startedOwner.stop();
  });

  it('starts from cache when network fails and stays STALE', async () => {
    cachedEntry = { wire: fixtureWire, fetchedAt: Date.now() - 1000 };
    cache = await ConfigurationCache.init({
      userDataPath: '/userData',
      site: 'datadoghq.com',
      env: 'e2e',
      clientToken: 'client-token',
      persistConfiguration: true,
    });
    fetchHandler = () => Promise.resolve(errorResponse(503));
    await startAndSettle(startOptions());
    expect(state.snapshot().status).toBe('STALE');
    expect(state.snapshot().configuration).toBe(fixtureWire);
  });

  it('an older network response never overwrites a newer configuration', async () => {
    fetchHandler = () => Promise.resolve(okResponse(rulesBinary));
    const owner = await startAndSettle(startOptions());
    const older = deferredResponse();
    const newer = deferredResponse();
    let call = 0;
    fetchHandler = () => {
      call += 1;
      return call === 1 ? older.promise : newer.promise;
    };
    await vi.advanceTimersByTimeAsync(300000); // refresh 1 (older, pending)
    await vi.advanceTimersByTimeAsync(300000); // refresh 2 (newer, pending)
    newer.resolve(okResponse(secondBinary));
    await vi.advanceTimersByTimeAsync(0);
    expect(wireResponseOf(state.snapshot().configuration!)).toBe(secondJSON.rules.response);
    older.resolve(okResponse(rulesBinary));
    await vi.advanceTimersByTimeAsync(0);
    expect(wireResponseOf(state.snapshot().configuration!)).toBe(secondJSON.rules.response);
    await owner.stop();
  });

  it('refreshes every refreshInterval and keeps serving the previous configuration on a warm failure', async () => {
    fetchHandler = () => Promise.resolve(okResponse(rulesBinary));
    const owner = await startAndSettle(startOptions());
    expect(state.snapshot().status).toBe('READY');
    fetchHandler = () => Promise.resolve(errorResponse(500));
    await vi.advanceTimersByTimeAsync(300000);
    expect(state.snapshot().status).toBe('STALE');
    expect(state.snapshot().configuration).toBeDefined();
    await owner.stop();
  });

  it('an authoritative failure stops serving the configuration until the next successful fetch restores it', async () => {
    fetchHandler = () => Promise.resolve(okResponse(rulesBinary));
    const owner = await startAndSettle(startOptions());
    fetchHandler = () => Promise.resolve(errorResponse(403));
    await vi.advanceTimersByTimeAsync(300000);
    expect(state.snapshot().status).toBe('ERROR');
    expect(state.snapshot().configuration).toBeUndefined();
    fetchHandler = () => Promise.resolve(okResponse(rulesBinary));
    await vi.advanceTimersByTimeAsync(300000);
    expect(state.snapshot().status).toBe('READY');
    expect(state.snapshot().configuration).toBeDefined();
    await owner.stop();
  });

  it('keeps refreshing while ERROR and recovers to READY when a fetch succeeds', async () => {
    fetchHandler = () => Promise.resolve(errorResponse(500));
    const owner = await startAndSettle(startOptions());
    expect(state.snapshot().status).toBe('ERROR');
    fetchHandler = () => Promise.resolve(okResponse(rulesBinary));
    await vi.advanceTimersByTimeAsync(300000);
    expect(state.snapshot().status).toBe('READY');
    await owner.stop();
  });

  it('refreshInterval 0 never schedules', async () => {
    fetchHandler = () => Promise.resolve(okResponse(rulesBinary));
    const owner = await startAndSettle(startOptions({ refreshInterval: 0 }));
    let calls = 0;
    fetchHandler = () => {
      calls += 1;
      return Promise.resolve(okResponse(rulesBinary));
    };
    await vi.advanceTimersByTimeAsync(600000);
    expect(calls).toBe(0);
    await owner.stop();
  });

  it('stop() clears the interval, aborts the in-flight fetch and waits for the pending write', async () => {
    fetchHandler = () => Promise.resolve(okResponse(rulesBinary));
    const owner = await startAndSettle(startOptions());
    // First refresh succeeds and leaves a cache write pending until released.
    let releaseWrite!: () => void;
    writeFile.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseWrite = resolve;
        })
    );
    await vi.advanceTimersByTimeAsync(300000);
    // Second refresh is held in flight (it would only settle on abort), right before stop().
    const signals: AbortSignal[] = [];
    fetchHandler = (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        signals.push(init.signal!);
        init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      });
    await vi.advanceTimersByTimeAsync(300000);
    expect(signals).toHaveLength(1);
    expect(signals[0].aborted).toBe(false);
    const statusBeforeStop = state.snapshot().status;
    const stopPromise = owner.stop();
    // Aborted by stop() itself, well before fetchTimeout could fire.
    expect(signals[0].aborted).toBe(true);
    let stopped = false;
    void stopPromise.then(() => {
      stopped = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(stopped).toBe(false);
    releaseWrite();
    await stopPromise;
    expect(stopped).toBe(true);
    expect(state.snapshot().status).toBe(statusBeforeStop);
    // No further refresh after stop.
    let calls = 0;
    fetchHandler = () => {
      calls += 1;
      return Promise.resolve(okResponse(rulesBinary));
    };
    await vi.advanceTimersByTimeAsync(600000);
    expect(calls).toBe(0);
  });

  it('start() serves the cache as STALE and returns before the first network fetch settles', async () => {
    cachedEntry = { wire: fixtureWire, fetchedAt: Date.now() - 1000 };
    cache = await ConfigurationCache.init({
      userDataPath: '/userData',
      site: 'datadoghq.com',
      env: 'e2e',
      clientToken: 'client-token',
      persistConfiguration: true,
    });
    const held = deferredResponse();
    fetchHandler = () => held.promise;
    let owner: FlagsOwner | undefined;
    void Promise.resolve(FlagsOwner.start(startOptions())).then((started) => {
      owner = started;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(owner).toBeDefined();
    expect(state.snapshot().status).toBe('STALE');
    held.resolve(okResponse(rulesBinary));
    await owner!.settled();
    expect(state.snapshot().status).toBe('READY');
    await owner!.stop();
  });

  it('a refresh that rejects is reported to telemetry, never as an unhandled rejection', async () => {
    fetchHandler = () => Promise.resolve(okResponse(rulesBinary));
    const owner = FlagsOwner.start(startOptions());
    await owner.settled();
    vi.spyOn(fetcher, 'fetch').mockRejectedValueOnce(new Error('refresh failure'));
    await vi.advanceTimersByTimeAsync(300000);
    expect(vi.mocked(addError)).toHaveBeenCalledWith(expect.objectContaining({ message: 'refresh failure' }));
    await owner.stop();
  });
});
