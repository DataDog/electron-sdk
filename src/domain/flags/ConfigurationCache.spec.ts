import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs/promises';

import { display } from '../../tools/display';
import { fixtureWire } from '../../common/flags/evaluationCases.specUtil';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore internal browser-core export, as in Telemetry.ts
import { startMonitorErrorCollection } from '@datadog/browser-core/cjs/tools/monitor';

vi.mock('node:fs/promises');

const { ConfigurationCache, CONFIGURATION_CACHE_MAX_AGE } = await import('./ConfigurationCache');

const readFile = vi.mocked(fs.readFile);
const writeFile = vi.mocked(fs.writeFile);
const unlink = vi.mocked(fs.unlink);
const mkdir = vi.mocked(fs.mkdir);

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
    mkdir.mockReset();
    mkdir.mockResolvedValue(undefined);
  });

  it('loads a cached configuration', async () => {
    const now = Date.now();
    readFile.mockResolvedValue(JSON.stringify({ wire: fixtureWire, fetchedAt: now - 1000 }));
    const cache = await ConfigurationCache.init(initOptions());
    const entry = cache.entry();
    expect(entry).toEqual({ wire: fixtureWire, fetchedAt: now - 1000 });
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
    readFile.mockResolvedValue(JSON.stringify({ wire: fixtureWire, fetchedAt: now - CONFIGURATION_CACHE_MAX_AGE - 1 }));
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
    await Promise.resolve();
    resolveWrite();
    await idle;
    expect(cache.entry()).toEqual({ wire: 'wire-1', fetchedAt: 1 });
  });
  it('serializes deleting an expired entry with later writes', async () => {
    readFile.mockResolvedValue(
      JSON.stringify({ wire: fixtureWire, fetchedAt: Date.now() - CONFIGURATION_CACHE_MAX_AGE - 1 })
    );
    let releaseUnlink!: () => void;
    unlink.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          releaseUnlink = resolve;
        })
    );
    const order: string[] = [];
    writeFile.mockImplementation(() => {
      order.push('write');
      return Promise.resolve();
    });
    const cache = await ConfigurationCache.init(initOptions());
    const write = cache.write(fixtureWire, Date.now() as never);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(order).toEqual([]);
    order.push('unlink');
    releaseUnlink();
    await write;
    expect(order).toEqual(['unlink', 'write']);
  });

  it.each([
    [
      'a wire that is not a valid configuration',
      () => JSON.stringify({ wire: 'not a wire', fetchedAt: Date.now() }),
      {},
    ],
    // JSON.parse turns 1e999 into Infinity.
    ['a non-finite fetchedAt', () => `{"wire":${JSON.stringify(fixtureWire)},"fetchedAt":1e999}`, {}],
    [
      'an oversize wire',
      () => JSON.stringify({ wire: fixtureWire, fetchedAt: Date.now() }),
      { maxConfigurationLength: 10 },
    ],
  ])('ignores an entry with %s and warns', async (_label, content, overrides) => {
    const warnSpy = vi.spyOn(display, 'warn').mockImplementation(() => undefined);
    readFile.mockResolvedValue(content());
    const cache = await ConfigurationCache.init(initOptions(overrides));
    expect(cache.entry()).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });

  it('write callbacks are monitored: a throwing callback reaches telemetry and the chain keeps working', async () => {
    const monitorErrors: unknown[] = [];
    startMonitorErrorCollection((error: unknown) => monitorErrors.push(error));
    const warnSpy = vi.spyOn(display, 'warn').mockImplementation(() => {
      throw new Error('callback failure');
    });
    try {
      readFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
      writeFile.mockRejectedValueOnce(new Error('disk full'));
      const cache = await ConfigurationCache.init(initOptions());
      await expect(cache.write(fixtureWire, 1 as never)).resolves.toBeUndefined();
      expect(monitorErrors).toEqual([expect.objectContaining({ message: 'callback failure' })]);
      writeFile.mockResolvedValueOnce(undefined);
      await expect(cache.write(fixtureWire, 2 as never)).resolves.toBeUndefined();
      expect(writeFile).toHaveBeenCalledTimes(2);
    } finally {
      warnSpy.mockRestore();
      startMonitorErrorCollection(() => undefined);
    }
  });
});
