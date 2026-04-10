import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockRegisterPreloadScript, mockExistsSync, mockDisplayInfo } = vi.hoisted(() => {
  const mockRegisterPreloadScript = vi.fn();
  const mockExistsSync = vi.fn();
  const mockDisplayInfo = vi.fn();
  return { mockRegisterPreloadScript, mockExistsSync, mockDisplayInfo };
});

let resolveWhenReady: () => void;

vi.mock('electron', () => ({
  session: {
    defaultSession: {
      registerPreloadScript: mockRegisterPreloadScript,
    },
  },
  app: {
    whenReady: vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveWhenReady = resolve;
        })
    ),
  },
}));

vi.mock('node:fs', () => ({
  existsSync: mockExistsSync,
}));

vi.mock('../tools/display', () => ({
  displayInfo: mockDisplayInfo,
}));

describe('registerPreload', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  async function loadAndRegister() {
    const { registerPreload } = await import('./registerPreload');
    registerPreload();
    resolveWhenReady();
  }

  it('should register the preload script when found next to current file', async () => {
    mockExistsSync.mockReturnValue(true);

    await loadAndRegister();

    expect(mockRegisterPreloadScript).toHaveBeenCalledOnce();
    expect(mockRegisterPreloadScript).toHaveBeenCalledWith({
      type: 'frame',
      filePath: expect.stringContaining('preload-auto.cjs') as string,
    });
  });

  it('should not call displayInfo when preload is found', async () => {
    mockExistsSync.mockReturnValue(true);

    await loadAndRegister();

    expect(mockDisplayInfo).not.toHaveBeenCalled();
  });

  it('should log info and skip registration when preload is not found', async () => {
    mockExistsSync.mockReturnValue(false);

    await loadAndRegister();

    expect(mockRegisterPreloadScript).not.toHaveBeenCalled();
    expect(mockDisplayInfo).toHaveBeenCalledOnce();
    expect(mockDisplayInfo).toHaveBeenCalledWith(expect.stringContaining('Auto-injection of preload-auto.cjs skipped'));
  });
});
