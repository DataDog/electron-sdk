import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs/promises';
import { timeStampNow, type TimeStamp } from '@datadog/js-core/time';

import { display } from '../../tools/display';
import {
  precomputedWire,
  precomputedContext,
  otherPrecomputedContext,
} from '../../common/flags/precomputedCases.specUtil';
import type { FlatContext } from '../../common/flags/types';

vi.mock('node:fs/promises');

const { PrecomputedCache, PRECOMPUTED_CACHE_MAX_CONTEXTS, precomputedCacheKey } = await import('./PrecomputedCache');
const { CONFIGURATION_CACHE_MAX_AGE } = await import('./ConfigurationCache');

const readFile = vi.mocked(fs.readFile);
const writeFile = vi.mocked(fs.writeFile);
const unlink = vi.mocked(fs.unlink);
const mkdir = vi.mocked(fs.mkdir);

function initOptions(overrides: Partial<Parameters<typeof PrecomputedCache.init>[0]> = {}) {
  return {
    userDataPath: '/userData',
    site: 'datadoghq.com',
    env: 'e2e',
    clientToken: 'client-token',
    persistConfiguration: true,
    ...overrides,
  };
}

/** The identity string `initOptions` builds, so the mocked keyFor matches the real one. */
const IDENTITY = 'datadoghq.com|e2e|client-token||';

/** Serve a full cache from the mocked fs: an index plus one entry file per context. */
function mockCacheContents(entries: { context: FlatContext; wire: string; fetchedAt: number; lastUsed: number }[]) {
  const keyFor = (context: FlatContext) => precomputedCacheKey(IDENTITY, context);
  const files = new Map<string, string>();
  for (const entry of entries) {
    files.set(
      `/userData/_dd_flags/precomputed/${keyFor(entry.context)}.json`,
      JSON.stringify({ wire: entry.wire, fetchedAt: entry.fetchedAt })
    );
  }
  readFile.mockImplementation((pathArg: unknown): Promise<string> => {
    const key = String(pathArg);
    if (key === '/userData/_dd_flags/precomputed/index.json') {
      return Promise.resolve(
        JSON.stringify({
          entries: entries.map((entry) => ({
            key: keyFor(entry.context),
            fetchedAt: entry.fetchedAt,
            lastUsed: entry.lastUsed,
          })),
        })
      );
    }
    const content = files.get(key);
    if (content === undefined) {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    }
    return Promise.resolve(content);
  });
  return { keyFor, files };
}

describe('PrecomputedCache', () => {
  beforeEach(() => {
    readFile.mockReset();
    writeFile.mockReset();
    unlink.mockReset();
    mkdir.mockReset();
    mkdir.mockResolvedValue(undefined);
    readFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
  });

  it('keys entries by site, env, token, proxy, applicationId and canonical context', async () => {
    readFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    const cache = await PrecomputedCache.init(initOptions());
    expect(cache.keyFor(precomputedContext)).toMatch(/^[0-9a-f]{64}$/);
    // A different identity component or context yields a different key.
    const otherEnv = await PrecomputedCache.init(initOptions({ env: 'other' }));
    expect(otherEnv.keyFor(precomputedContext)).not.toBe(cache.keyFor(precomputedContext));
    const withProxy = await PrecomputedCache.init(initOptions({ flaggingProxy: 'http://localhost:9222' }));
    expect(withProxy.keyFor(precomputedContext)).not.toBe(cache.keyFor(precomputedContext));
    const withApplicationId = await PrecomputedCache.init(initOptions({ applicationId: 'app' }));
    expect(withApplicationId.keyFor(precomputedContext)).not.toBe(cache.keyFor(precomputedContext));
    expect(cache.keyFor(otherPrecomputedContext)).not.toBe(cache.keyFor(precomputedContext));
    // Key order inside the context does not matter.
    expect(cache.keyFor({ plan: 'pro', targetingKey: 'user-pro' })).toBe(cache.keyFor(precomputedContext));
  });

  it('returns the entry for a context and nothing for another', async () => {
    const { keyFor } = mockCacheContents([
      { context: precomputedContext, wire: precomputedWire, fetchedAt: Date.now() - 1000, lastUsed: Date.now() - 1000 },
    ]);
    const cache = await PrecomputedCache.init(initOptions());
    expect(cache.entry(precomputedContext)).toMatchObject({ wire: precomputedWire });
    expect(cache.entry(otherPrecomputedContext)).toBeUndefined();
    // The entry file is scoped by the context key.
    expect(readFile).toHaveBeenCalledWith(
      `/userData/_dd_flags/precomputed/${keyFor(precomputedContext)}.json`,
      'utf-8'
    );
  });

  it('keeps at most 5 contexts and evicts the least recently used', async () => {
    const { keyFor } = mockCacheContents([
      { context: precomputedContext, wire: precomputedWire, fetchedAt: Date.now(), lastUsed: 1 },
      ...Array.from({ length: 5 }, (_, i) => ({
        context: { targetingKey: `user-${i}` },
        wire: precomputedWire,
        fetchedAt: Date.now(),
        lastUsed: 10 + i,
      })),
    ]);
    const cache = await PrecomputedCache.init(initOptions());
    // The least recently used entry (precomputedContext) was evicted at init.
    expect(cache.entry(precomputedContext)).toBeUndefined();
    expect(cache.entry({ targetingKey: 'user-0' })).toBeDefined();
    await cache.idle();
    expect(unlink).toHaveBeenCalledWith(`/userData/_dd_flags/precomputed/${keyFor(precomputedContext)}.json`);

    // A sixth write evicts the least recently used live entry.
    const evicted = { targetingKey: 'user-0' } as FlatContext;
    // Touch every other entry so user-0 becomes the least recently used.
    for (const key of ['user-1', 'user-2', 'user-3', 'user-4']) {
      cache.entry({ targetingKey: key });
    }
    void cache.write({ targetingKey: 'sixth' }, precomputedWire, timeStampNow());
    await cache.idle();
    expect(cache.entry(evicted)).toBeUndefined();
    expect(cache.entry({ targetingKey: 'sixth' })).toBeDefined();
    expect(cache.entry({ targetingKey: 'user-4' })).toBeDefined();
    expect(PRECOMPUTED_CACHE_MAX_CONTEXTS).toBe(5);
  });

  it('drops entries older than the max age', async () => {
    const { keyFor } = mockCacheContents([
      {
        context: precomputedContext,
        wire: precomputedWire,
        fetchedAt: Date.now() - CONFIGURATION_CACHE_MAX_AGE - 1,
        lastUsed: Date.now(),
      },
    ]);
    const cache = await PrecomputedCache.init(initOptions());
    expect(cache.entry(precomputedContext)).toBeUndefined();
    await cache.idle();
    expect(unlink).toHaveBeenCalledWith(`/userData/_dd_flags/precomputed/${keyFor(precomputedContext)}.json`);
  });

  it('serializes concurrent writes and the last write wins', async () => {
    const order: string[] = [];
    writeFile.mockImplementation((pathArg: unknown): Promise<undefined> => {
      order.push(String(pathArg));
      return Promise.resolve(undefined);
    });
    const cache = await PrecomputedCache.init(initOptions());
    // Fixed timestamps: re-evaluating Date.now() at assertion time raced the wall clock
    // (a millisecond elapsing between the writes and the read made the test flaky).
    const firstAt = Date.now();
    const secondAt = firstAt + 1;
    const first = cache.write(precomputedContext, precomputedWire, firstAt as TimeStamp);
    const second = cache.write(precomputedContext, precomputedWire, secondAt as TimeStamp);
    await Promise.all([first, second]);
    await cache.idle();
    // Two writes for the same context keep one entry file; the index is written last.
    expect(order[order.length - 1]).toContain('index.json');
    expect(cache.entry(precomputedContext)).toMatchObject({ fetchedAt: secondAt });
  });

  it('re-checks age on lookup: an entry that aged out after startup is not returned without a restart', async () => {
    vi.useFakeTimers();
    try {
      const day = 24 * 60 * 60 * 1000;
      mockCacheContents([
        { context: precomputedContext, wire: precomputedWire, fetchedAt: Date.now() - 6 * day, lastUsed: Date.now() },
      ]);
      const cache = await PrecomputedCache.init(initOptions());
      // Valid at startup (6 days old); two more days pass while the app runs: the lookup
      // must re-check the age and not serve week-old kill-switch states.
      vi.setSystemTime(Date.now() + 2 * day);
      expect(cache.entry(precomputedContext)).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a recently read context survives eviction after a restart', async () => {
    const day = 24 * 60 * 60 * 1000;
    // A full cache: the oldest-lastUsed entry is the eviction candidate.
    const contexts: FlatContext[] = Array.from({ length: PRECOMPUTED_CACHE_MAX_CONTEXTS }, (_, n) => ({
      targetingKey: `user-${n}`,
    }));
    mockCacheContents(
      contexts.map((context, n) => ({
        context,
        wire: precomputedWire,
        fetchedAt: Date.now() - day,
        // user-0 is the least recently used at startup.
        lastUsed: Date.now() - day * (PRECOMPUTED_CACHE_MAX_CONTEXTS - n),
      }))
    );
    const cache = await PrecomputedCache.init(initOptions());
    // Reading user-0 refreshes its recency, and the refreshed index is persisted.
    expect(cache.entry(contexts[0])).toBeDefined();
    await cache.idle();

    // A restart with one more context than the bound: user-0 was read recently, so the
    // evicted entry is another one, not the recently read context.
    const extra: FlatContext = { targetingKey: 'user-extra' };
    const indexWrites = writeFile.mock.calls
      .map((call) => call as unknown as [string, string])
      .filter(([path]) => path.endsWith('index.json'));
    const indexWrite = indexWrites[indexWrites.length - 1];
    expect(indexWrite).toBeDefined();
    const persisted = JSON.parse(indexWrite[1]) as { entries: { key: string; lastUsed: number }[] };
    const persistedUser0 = persisted.entries.find((entry) => entry.key === precomputedCacheKey(IDENTITY, contexts[0]));
    expect(persistedUser0).toBeDefined();
    expect(persistedUser0!.lastUsed).toBeGreaterThan(Date.now() - 1000);
    mockCacheContents([
      ...contexts.map((context) => ({
        context,
        wire: precomputedWire,
        fetchedAt: Date.now() - day,
        lastUsed: persisted.entries.find((e) => e.key === precomputedCacheKey(IDENTITY, context))!.lastUsed,
      })),
      { context: extra, wire: precomputedWire, fetchedAt: Date.now(), lastUsed: Date.now() },
    ]);
    const restarted = await PrecomputedCache.init(initOptions());
    expect(restarted.entry(contexts[0])).toBeDefined();
    expect(restarted.entry(extra)).toBeDefined();
  });

  it('ignores a corrupt entry with display.warn', async () => {
    const warn = vi.spyOn(display, 'warn').mockImplementation(() => undefined);
    mockCacheContents([
      { context: precomputedContext, wire: precomputedWire, fetchedAt: Date.now(), lastUsed: Date.now() },
    ]);
    readFile.mockImplementation((pathArg: unknown): Promise<string> => {
      const key = String(pathArg);
      if (key === '/userData/_dd_flags/precomputed/index.json') {
        return Promise.resolve('{not json');
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    const cache = await PrecomputedCache.init(initOptions());
    expect(cache.entry(precomputedContext)).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('corrupt'));

    readFile.mockImplementation((pathArg: unknown) => {
      const key = String(pathArg);
      if (key === '/userData/_dd_flags/precomputed/index.json') {
        return Promise.resolve(
          JSON.stringify({ entries: [{ key: 'abc', fetchedAt: Date.now(), lastUsed: Date.now() }] })
        );
      }
      return Promise.resolve('{not json');
    });
    const corruptEntry = await PrecomputedCache.init(initOptions());
    expect(corruptEntry.entry(precomputedContext)).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('corrupt'));
    warn.mockRestore();
  });

  it('persistConfiguration false never reads or writes', async () => {
    const cache = await PrecomputedCache.init(initOptions({ persistConfiguration: false }));
    expect(readFile).not.toHaveBeenCalled();
    void cache.write(precomputedContext, precomputedWire, timeStampNow());
    await cache.idle();
    expect(writeFile).not.toHaveBeenCalled();
    // The in-memory entry is still served (offline fallback within the session).
    expect(cache.entry(precomputedContext)).toMatchObject({ wire: precomputedWire });
  });
});
