import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  cpSync: vi.fn(),
  createRequire: vi.fn(),
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  readFileSync: vi.fn(),
}));

vi.mock('node:fs', () => ({
  cpSync: mocks.cpSync,
  existsSync: mocks.existsSync,
  mkdirSync: mocks.mkdirSync,
  readFileSync: mocks.readFileSync,
}));
vi.mock('node:module', () => ({ createRequire: mocks.createRequire }));

import { datadogVitePlugin } from './vite-plugin';

describe('datadogVitePlugin', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('resolves transitive dependencies from their parent package', () => {
    const rootResolve = vi.fn((pkg: string) => {
      if (pkg === 'dd-trace') return '/packages/dd-trace/index.js';
      if (pkg === '@datadog/electron-sdk') return '/packages/electron-sdk/index.js';
      throw new Error(`Cannot resolve ${pkg}`);
    });
    const ddTraceResolve = vi.fn(() => '/packages/nested-package/index.js');

    mocks.createRequire.mockImplementation((path: string) => ({
      resolve: path === '/packages/dd-trace/package.json' ? ddTraceResolve : rootResolve,
    }));
    mocks.existsSync.mockImplementation((path: string) =>
      path.startsWith('/packages/') ? path.endsWith('/package.json') : false
    );
    mocks.readFileSync.mockImplementation((path: string) =>
      JSON.stringify({ dependencies: path === '/packages/dd-trace/package.json' ? { 'nested-package': '1.0.0' } : {} })
    );

    datadogVitePlugin().writeBundle?.({ dir: '/output' });

    expect(ddTraceResolve).toHaveBeenCalledWith('nested-package');
    expect(mocks.cpSync).toHaveBeenCalledWith('/packages/nested-package', '/output/node_modules/nested-package', {
      recursive: true,
    });
  });
});
