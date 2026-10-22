vi.mock('node:os', () => ({
  default: {
    platform: vi.fn(() => 'darwin'),
    arch: vi.fn(() => 'x64'),
    release: vi.fn(() => ''),
  },
}));

import { describe, it, expect, vi, beforeEach } from 'vitest';
import os from 'node:os';
import { getUserAgent } from './userAgent';

const mockPlatform = os.platform as unknown as ReturnType<typeof vi.fn>;
const mockArch = os.arch as unknown as ReturnType<typeof vi.fn>;
const mockRelease = os.release as unknown as ReturnType<typeof vi.fn>;

function stubProcess(extra: Partial<NodeJS.Process> = {}) {
  vi.stubGlobal('process', {
    ...process,
    versions: { ...process.versions, electron: '30.0.0', chrome: '124.0.0', node: '20.14.0' },
    ...extra,
  });
}

describe('getUserAgent', () => {
  beforeEach(() => {
    mockPlatform.mockReset();
    mockArch.mockReset();
    mockRelease.mockReset();
    vi.unstubAllGlobals();
  });

  it('returns correct format on macOS', () => {
    mockPlatform.mockReturnValue('darwin');
    mockArch.mockReturnValue('x64');
    stubProcess({ getSystemVersion: () => '15.3.0' });

    expect(getUserAgent()).toBe('(Macintosh; Intel Mac OS X 15_3_0) Electron/30.0.0 Chrome/124.0.0 Node/20.14.0');
  });

  it('appends .0 to two-part macOS versions', () => {
    mockPlatform.mockReturnValue('darwin');
    mockArch.mockReturnValue('x64');
    stubProcess({ getSystemVersion: () => '15.3' });

    expect(getUserAgent()).toContain('Mac OS X 15_3_0');
  });

  it('falls back when process.getSystemVersion is unavailable', () => {
    mockPlatform.mockReturnValue('darwin');
    mockArch.mockReturnValue('arm64');
    stubProcess();

    expect(getUserAgent()).toContain('(darwin; arm64)');
  });

  it('returns correct format on Windows', () => {
    mockPlatform.mockReturnValue('win32');
    mockArch.mockReturnValue('x64');
    mockRelease.mockReturnValue('10.0.22621');
    stubProcess();

    expect(getUserAgent()).toBe('(Windows NT 10.0; Win64; x64) Electron/30.0.0 Chrome/124.0.0 Node/20.14.0');
  });

  it('reports ARM64 on Windows arm64', () => {
    mockPlatform.mockReturnValue('win32');
    mockArch.mockReturnValue('arm64');
    mockRelease.mockReturnValue('10.0.22621');
    stubProcess();

    expect(getUserAgent()).toContain('Windows NT 10.0; ARM64');
  });

  it('returns correct format on Linux', () => {
    mockPlatform.mockReturnValue('linux');
    mockArch.mockReturnValue('x64');
    stubProcess();

    expect(getUserAgent()).toBe('(X11; Linux x86_64) Electron/30.0.0 Chrome/124.0.0 Node/20.14.0');
  });

  it('maps arm64 to aarch64 on Linux', () => {
    mockPlatform.mockReturnValue('linux');
    mockArch.mockReturnValue('arm64');
    stubProcess();

    expect(getUserAgent()).toContain('Linux aarch64');
  });

  it('returns generic fallback for unknown platforms', () => {
    mockPlatform.mockReturnValue('freebsd');
    mockArch.mockReturnValue('x64');
    stubProcess();

    expect(getUserAgent()).toContain('(freebsd; x64)');
  });
});
