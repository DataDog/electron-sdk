import { describe, it, expect, vi, beforeEach } from 'vitest';
import { app } from 'electron';
import { sdkPaths } from './sdkPaths';

vi.mock('electron', () => ({
  app: {
    getAppPath: vi.fn(() => '/Applications/MyApp.app/Contents/Resources/app.asar'),
    getPath: vi.fn((name: string) => `/Users/alice/Library/Application Support/MyApp/${name}`),
  },
}));

describe('sdkPaths', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reads the app path from electron', () => {
    expect(sdkPaths.appPath()).toBe('/Applications/MyApp.app/Contents/Resources/app.asar');
  });

  it('reads userData and crashDumps from electron', () => {
    expect(sdkPaths.userData()).toBe('/Users/alice/Library/Application Support/MyApp/userData');
    expect(sdkPaths.crashDumps()).toBe('/Users/alice/Library/Application Support/MyApp/crashDumps');
  });

  it('returns the current value on each call', () => {
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const getPathMock = vi.mocked(app.getPath);
    sdkPaths.userData();
    getPathMock.mockReturnValueOnce('/moved/userData');
    expect(sdkPaths.userData()).toBe('/moved/userData');
    expect(getPathMock).toHaveBeenCalledTimes(2);
  });
});
