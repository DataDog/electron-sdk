import { describe, expect, it, vi } from 'vitest';

import { datadogEsbuildPlugin } from './esbuild-plugin';
import { datadogVitePlugin } from './vite-plugin';
import { DatadogWebpackPlugin } from './webpack-plugin';

describe('runtime dependency copying', () => {
  it('can be delegated to the packager for Vite', () => {
    expect(datadogVitePlugin().writeBundle).toBeTypeOf('function');
    expect(datadogVitePlugin({ copyRuntimeDependencies: false }).writeBundle).toBeUndefined();
  });

  it('can be delegated to the packager for esbuild', () => {
    const defaultOnEnd = vi.fn();
    datadogEsbuildPlugin().setup({ initialOptions: {}, onEnd: defaultOnEnd });
    expect(defaultOnEnd).toHaveBeenCalledOnce();

    const managedOnEnd = vi.fn();
    datadogEsbuildPlugin({ copyRuntimeDependencies: false }).setup({
      initialOptions: {},
      onEnd: managedOnEnd,
    });
    expect(managedOnEnd).not.toHaveBeenCalled();
  });

  it('can be delegated to the packager for webpack', () => {
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
    expect(managedAfterEmitCalls).toBe(0);
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
