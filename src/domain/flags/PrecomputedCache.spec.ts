import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs/promises';

import { display } from '../../tools/display';
import { precomputedWire, precomputedContext, otherPrecomputedContext } from '../../common/flags/precomputedCases.specUtil';
import type { FlatContext } from '../../common/flags/types';

vi.mock('node:fs/promises');

const { PrecomputedCache, PRECOMPUTED_CACHE_MAX_CONTEXTS } = await import('./PrecomputedCache');
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
  const cache = new PrecomputedCache('/userData/_dd_flags/precomputed', IDENTITY, true, 8 * 1024 * 1024);
  const keyFor = (context: FlatContext) => cache.keyFor(context);
  const files = new Map<string, string>();
  for (const entry of entries) {
    files.set(`/userData/_dd_flags/precomputed/${keyFor(entry.context)}.json`, JSON.stringify({ wire: entry.wire, fetchedAt: entry.fetchedAt }));
  }
  readFile.mockImplementation(async (pathArg: unknown) => {
    const key = String(pathArg);
    if (key === '/userData/_dd_flags/precomputed/index.json') {
      return JSON.stringify({
        entries: entries.map((entry) => ({ key: keyFor(entry.context), fetchedAt: entry.fetchedAt, lastUsed: entry.lastUsed })),
      });
    }
    const content = files.get(key);
    if (content === undefined) {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    }
    return content;
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
    expect(readFile).toHaveBeenCalledWith(`/userData/_dd_flags/precomputed/${keyFor(precomputedContext)}.json`, 'utf-8');
  });

  it('keeps at most 5 contexts and evicts the least recently used', async () => {
    const { keyFor } = mockCacheContents([
      { context: precomputedContext, wire: precomputedWire, fetchedAt: Date.now(), lastUsed: 1 },
      ...Array.from({ length: 5 }, (_, i) => ({
        context: { targetingKey: `user-${i}` } as FlatContext,
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
    cache.write({ targetingKey: 'sixth' }, precomputedWire, Date.now());
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
    writeFile.mockImplementation(async (pathArg: unknown) => {
      order.push(String(pathArg));
      return undefined;
    });
    const cache = await PrecomputedCache.init(initOptions());
    const first = cache.write(precomputedContext, precomputedWire, 1);
    const second = cache.write(precomputedContext, precomputedWire, 2);
    await Promise.all([first, second]);
    await cache.idle();
    // Two writes for the same context keep one entry file; the index is written last.
    expect(order[order.length - 1]).toContain('index.json');
    expect(cache.entry(precomputedContext)).toMatchObject({ fetchedAt: 2 });
  });

  it('ignores a corrupt entry with display.warn', async () => {
    const warn = vi.spyOn(display, 'warn').mockImplementation(() => undefined);
    mockCacheContents([{ context: precomputedContext, wire: precomputedWire, fetchedAt: Date.now(), lastUsed: Date.now() }]);
    readFile.mockImplementation(async (pathArg: unknown) => {
      const key = String(pathArg);
      if (key === '/userData/_dd_flags/precomputed/index.json') {
        return '{not json';
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    const cache = await PrecomputedCache.init(initOptions());
    expect(cache.entry(precomputedContext)).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('corrupt'));

    readFile.mockImplementation(async (pathArg: unknown) => {
      const key = String(pathArg);
      if (key === '/userData/_dd_flags/precomputed/index.json') {
        return JSON.stringify({ entries: [{ key: 'abc', fetchedAt: Date.now(), lastUsed: Date.now() }] });
      }
      return '{not json';
    });
    const corruptEntry = await PrecomputedCache.init(initOptions());
    expect(corruptEntry.entry(precomputedContext)).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('corrupt'));
    warn.mockRestore();
  });

  it('persistConfiguration false never reads or writes', async () => {
    const cache = await PrecomputedCache.init(initOptions({ persistConfiguration: false }));
    expect(readFile).not.toHaveBeenCalled();
    cache.write(precomputedContext, precomputedWire, Date.now());
    await cache.idle();
    expect(writeFile).not.toHaveBeenCalled();
    // The in-memory entry is still served (offline fallback within the session).
    expect(cache.entry(precomputedContext)).toMatchObject({ wire: precomputedWire });
  });
});
