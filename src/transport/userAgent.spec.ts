vi.mock('electron', () => ({
  app: {
    getName: vi.fn(() => 'TestApp'),
    getVersion: vi.fn(() => '1.2.3'),
  },
}));

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

vi.mock('node:os', () => ({
  default: {
    platform: vi.fn(() => 'darwin'),
    arch: vi.fn(() => 'x64'),
    release: vi.fn(() => ''),
  },
}));

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { execFile } from 'node:child_process';
import os from 'node:os';
import { getUserAgent, resetUserAgentCache } from './userAgent';

const mockExecFile = execFile as unknown as ReturnType<typeof vi.fn>;
const mockPlatform = os.platform as unknown as ReturnType<typeof vi.fn>;
const mockArch = os.arch as unknown as ReturnType<typeof vi.fn>;
const mockRelease = os.release as unknown as ReturnType<typeof vi.fn>;

function mockExecFileSuccess(stdout: string) {
  mockExecFile.mockImplementation(
    (_cmd: string, _args: string[], _opts: object, cb: (err: Error | null, stdout: string) => void) => {
      cb(null, stdout);
    }
  );
}

function mockExecFileError() {
  mockExecFile.mockImplementation(
    (_cmd: string, _args: string[], _opts: object, cb: (err: Error | null, stdout: string) => void) => {
      cb(new Error('command not found'), '');
    }
  );
}

describe('getUserAgent', () => {
  beforeEach(() => {
    resetUserAgentCache();
    mockExecFile.mockReset();
    mockPlatform.mockReset();
    mockArch.mockReset();
    mockRelease.mockReset();
    vi.stubGlobal('process', {
      ...process,
      versions: { ...process.versions, electron: '30.0.0', chrome: '124.0.0', node: '20.14.0' },
    });
  });

  it('returns correct format on macOS', async () => {
    mockPlatform.mockReturnValue('darwin');
    mockArch.mockReturnValue('x64');
    mockExecFileSuccess('15.3.0\n');

    const ua = await getUserAgent();

    expect(ua).toBe('TestApp/1.2.3 (Macintosh; Intel Mac OS X 15_3_0) Electron/30.0.0 Chrome/124.0.0 Node/20.14.0');
  });

  it('appends .0 to two-part macOS versions', async () => {
    mockPlatform.mockReturnValue('darwin');
    mockArch.mockReturnValue('x64');
    mockExecFileSuccess('15.3\n');

    const ua = await getUserAgent();

    expect(ua).toContain('Mac OS X 15_3_0');
  });

  it('falls back on macOS sw_vers error', async () => {
    mockPlatform.mockReturnValue('darwin');
    mockArch.mockReturnValue('arm64');
    mockExecFileError();

    const ua = await getUserAgent();

    expect(ua).toContain('(darwin; arm64)');
  });

  it('returns correct format on Windows', async () => {
    mockPlatform.mockReturnValue('win32');
    mockArch.mockReturnValue('x64');
    mockRelease.mockReturnValue('10.0.22621');

    const ua = await getUserAgent();

    expect(ua).toBe('TestApp/1.2.3 (Windows NT 10.0; Win64; x64) Electron/30.0.0 Chrome/124.0.0 Node/20.14.0');
  });

  it('returns correct format on Linux', async () => {
    mockPlatform.mockReturnValue('linux');
    mockArch.mockReturnValue('x64');

    const ua = await getUserAgent();

    expect(ua).toBe('TestApp/1.2.3 (X11; Linux x86_64) Electron/30.0.0 Chrome/124.0.0 Node/20.14.0');
  });

  it('maps arm64 to aarch64 on Linux', async () => {
    mockPlatform.mockReturnValue('linux');
    mockArch.mockReturnValue('arm64');

    const ua = await getUserAgent();

    expect(ua).toContain('Linux aarch64');
  });

  it('returns generic fallback for unknown platforms', async () => {
    mockPlatform.mockReturnValue('freebsd');
    mockArch.mockReturnValue('x64');

    const ua = await getUserAgent();

    expect(ua).toContain('(freebsd; x64)');
  });

  it('caches the result across calls', async () => {
    mockPlatform.mockReturnValue('linux');
    mockArch.mockReturnValue('x64');

    const first = await getUserAgent();
    const second = await getUserAgent();

    expect(first).toBe(second);
    expect(mockPlatform).toHaveBeenCalledTimes(1);
  });
});
