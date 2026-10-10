import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs/promises';

vi.mock('node:fs/promises');

const { ConfigurationCache, CONFIGURATION_CACHE_MAX_AGE } = await import('./ConfigurationCache');

const readFile = vi.mocked(fs.readFile);
const writeFile = vi.mocked(fs.writeFile);
const unlink = vi.mocked(fs.unlink);

function initOptions(overrides: Partial<Parameters<typeof ConfigurationCache.init>[0]> = {}) {
  return {
    userDataPath: '/userData',
    site: 'datadoghq.com',
    env: 'e2e',
    clientToken: 'client-token',
    persistConfiguration: true,
    ...overrides,
  };
}

describe('ConfigurationCache', () => {
  beforeEach(() => {
    readFile.mockReset();
    writeFile.mockReset();
    unlink.mockReset();
  });

  it('loads a cached configuration', async () => {
    const now = Date.now();
    readFile.mockResolvedValue(JSON.stringify({ wire: 'wire-1', fetchedAt: now - 1000 }));
    const cache = await ConfigurationCache.init(initOptions());
    const entry = cache.entry();
    expect(entry).toEqual({ wire: 'wire-1', fetchedAt: now - 1000 });
  });

  it('scopes the file by site, env, client token and flaggingProxy', async () => {
    readFile.mockRejectedValue(new Error('ENOENT'));
    const plain = await ConfigurationCache.init(initOptions());
    expect(plain.filePath).toMatch(/^\/userData\/_dd_flags\/[0-9a-f]{64}\.json$/);
    const withProxy = await ConfigurationCache.init(initOptions({ flaggingProxy: 'http://localhost:9222' }));
    expect(withProxy.filePath).not.toBe(plain.filePath);
    const otherEnv = await ConfigurationCache.init(initOptions({ env: 'other' }));
    expect(otherEnv.filePath).not.toBe(plain.filePath);
  });

  it('ignores and deletes an entry older than CONFIGURATION_CACHE_MAX_AGE', async () => {
    const now = Date.now();
    readFile.mockResolvedValue(JSON.stringify({ wire: 'wire-1', fetchedAt: now - CONFIGURATION_CACHE_MAX_AGE - 1 }));
    const cache = await ConfigurationCache.init(initOptions());
    expect(cache.entry()).toBeUndefined();
    expect(unlink).toHaveBeenCalledWith(cache.filePath);
  });

  it('ignores a corrupt file with display.warn', async () => {
    const warn = vi.spyOn(display, 'warn').mockImplementation(() => undefined);
    readFile.mockResolvedValue('{not json');
    const cache = await ConfigurationCache.init(initOptions());
    expect(cache.entry()).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('corrupt feature flags configuration cache'));
    warn.mockRestore();
  });

  it('serializes concurrent writes and the last write wins', async () => {
    readFile.mockRejectedValue(new Error('ENOENT'));
    const writes: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    writeFile.mockImplementation(async (_file, data) => {
      if (writes.length === 0) {
        await gate;
      }
      writes.push(data as string);
    });
    const cache = await ConfigurationCache.init(initOptions());
    const first = cache.write('wire-1', 1 as never);
    const second = cache.write('wire-2', 2 as never);
    release();
    await Promise.all([first, second]);
    // The first write started first but the last write wins: only the final state is on disk.
    expect(writes[writes.length - 1]).toContain('wire-2');
    expect(cache.entry()).toEqual({ wire: 'wire-2', fetchedAt: 2 });
  });

  it('write failure warns and keeps memory state', async () => {
    const warn = vi.spyOn(display, 'warn').mockImplementation(() => undefined);
    readFile.mockRejectedValue(new Error('ENOENT'));
    writeFile.mockRejectedValue(new Error('disk full'));
    const cache = await ConfigurationCache.init(initOptions());
    await cache.write('wire-1', 1 as never);
    expect(cache.entry()).toEqual({ wire: 'wire-1', fetchedAt: 1 });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Cannot persist the feature flags configuration cache'));
    warn.mockRestore();
  });

  it('persistConfiguration false never reads or writes', async () => {
    const cache = await ConfigurationCache.init(initOptions({ persistConfiguration: false }));
    expect(readFile).not.toHaveBeenCalled();
    await cache.write('wire-1', 1 as never);
    expect(writeFile).not.toHaveBeenCalled();
    expect(cache.entry()).toEqual({ wire: 'wire-1', fetchedAt: 1 });
  });

  it('resolves idle once the pending write has settled', async () => {
    readFile.mockRejectedValue(new Error('ENOENT'));
    let resolveWrite!: () => void;
    writeFile.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveWrite = resolve;
        })
    );
    const cache = await ConfigurationCache.init(initOptions());
    void cache.write('wire-1', 1 as never);
    const idle = cache.idle();
    await Promise.resolve();
    resolveWrite();
    await idle;
    expect(cache.entry()).toEqual({ wire: 'wire-1', fetchedAt: 1 });
  });
});
