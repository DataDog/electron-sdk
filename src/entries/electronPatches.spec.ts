import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as os from 'node:os';

vi.mock('preload-content', () => ({ default: 'const x = 1' }));
vi.mock('node:fs');

describe('resolvePreloadPath', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('writes the embedded content to tmpdir and returns the path', async () => {
    const fs = await import('node:fs');
    const writeSpy = vi.mocked(fs.writeFileSync).mockReturnValue(undefined);
    const { resolvePreloadPath } = await import('./electronPatches');
    const result = resolvePreloadPath();
    expect(result).toContain(os.tmpdir());
    expect(result).toContain('datadog-preload-');
    expect(writeSpy).toHaveBeenCalledWith(result, 'const x = 1', { flag: 'wx' });
  });

  it('returns the tmp path even when the file already exists (EEXIST)', async () => {
    const fs = await import('node:fs');
    vi.mocked(fs.writeFileSync).mockImplementation(() => {
      const err = Object.assign(new Error('EEXIST'), { code: 'EEXIST' });
      throw err;
    });
    const { resolvePreloadPath } = await import('./electronPatches');
    const result = resolvePreloadPath();
    expect(result).toContain('datadog-preload-');
  });

  it('returns undefined and warns when write fails with unexpected error and resolve fails', async () => {
    const fs = await import('node:fs');
    vi.mocked(fs.writeFileSync).mockImplementation(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    const warnSpy = vi.spyOn(console, 'warn').mockReturnValue(undefined);
    const { resolvePreloadPath } = await import('./electronPatches');
    const result = resolvePreloadPath(() => {
      throw new Error('MODULE_NOT_FOUND');
    });
    expect(result).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('[datadog]'));
  });

  it('returns the resolved path when write fails but resolve succeeds', async () => {
    const fs = await import('node:fs');
    vi.mocked(fs.writeFileSync).mockImplementation(() => {
      throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
    });
    const resolvedPath = '/node_modules/@datadog/electron-sdk/dist/electron/preload.js';
    const { resolvePreloadPath } = await import('./electronPatches');
    const result = resolvePreloadPath(() => resolvedPath);
    expect(result).toBe(resolvedPath);
  });
});
