import { describe, expect, it, vi } from 'vitest';

import { datadogEsbuildPlugin } from './esbuild-plugin';
import { datadogVitePlugin } from './vite-plugin';
import { DatadogWebpackPlugin } from './webpack-plugin';

describe('runtime dependency copying', () => {
  it('keeps the Vite output hook when dd-trace staging is delegated to the packager', () => {
    expect(datadogVitePlugin().writeBundle).toBeTypeOf('function');
    expect(datadogVitePlugin({ copyRuntimeDependencies: false }).writeBundle).toBeTypeOf('function');
  });

  it('keeps the esbuild output hook when dd-trace staging is delegated to the packager', () => {
    const defaultOnEnd = vi.fn();
    datadogEsbuildPlugin().setup({ initialOptions: {}, onEnd: defaultOnEnd });
    expect(defaultOnEnd).toHaveBeenCalledOnce();

    const managedOnEnd = vi.fn();
    datadogEsbuildPlugin({ copyRuntimeDependencies: false }).setup({
      initialOptions: {},
      onEnd: managedOnEnd,
    });
    expect(managedOnEnd).toHaveBeenCalledOnce();
  });

  it('keeps the webpack output hook when dd-trace staging is delegated to the packager', () => {
    let defaultAfterEmitCalls = 0;
    new DatadogWebpackPlugin().apply(
      createWebpackCompiler(() => {
        defaultAfterEmitCalls += 1;
      })
    );
    expect(defaultAfterEmitCalls).toBe(1);

    let managedAfterEmitCalls = 0;
    new DatadogWebpackPlugin({ copyRuntimeDependencies: false }).apply(
      createWebpackCompiler(() => {
        managedAfterEmitCalls += 1;
      })
    );
    expect(managedAfterEmitCalls).toBe(1);
  });

  it('externalizes dd-trace but allows Vite to bundle the Electron SDK', () => {
    const external = datadogVitePlugin().config?.().build.rollupOptions.external ?? [];

    expect(external.some((pattern) => pattern.test('dd-trace'))).toBe(true);
    expect(external.some((pattern) => pattern.test('@datadog/electron-sdk'))).toBe(false);
  });

  it('externalizes dd-trace but allows esbuild to bundle the Electron SDK', () => {
    const initialOptions: { external?: string[] } = {};
    datadogEsbuildPlugin().setup({ initialOptions, onEnd: vi.fn() });

    expect(initialOptions.external).toContain('dd-trace');
    expect(initialOptions.external).not.toContain('@datadog/electron-sdk');
  });

  it('externalizes dd-trace but allows webpack to bundle the Electron SDK', () => {
    const compiler = createWebpackCompiler(vi.fn());
    new DatadogWebpackPlugin().apply(compiler);

    const externals = compiler.options.externals as RegExp[];
    expect(externals.some((pattern) => pattern.test('dd-trace'))).toBe(true);
    expect(externals.some((pattern) => pattern.test('@datadog/electron-sdk'))).toBe(false);
  });
});

function createWebpackCompiler(
  afterEmit: Parameters<DatadogWebpackPlugin['apply']>[0]['hooks']['afterEmit']['tap']
): Parameters<DatadogWebpackPlugin['apply']>[0] {
  class BannerPlugin {
    constructor(options: { banner: string; raw: boolean; entryOnly: boolean }) {
      void options;
    }

    apply(compiler: Parameters<DatadogWebpackPlugin['apply']>[0]): void {
      void compiler;
    }
  }

  return {
    options: {
      module: {
        rules: [],
      },
    },
    webpack: {
      BannerPlugin,
    },
    hooks: {
      afterEmit: {
        tap(name, callback) {
          afterEmit(name, callback);
        },
      },
    },
  };
}
