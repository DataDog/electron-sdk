import { describe, expect, it, vi } from 'vitest';

import { datadogEsbuildPlugin } from './esbuild-plugin';
import { datadogVitePlugin } from './vite-plugin';
import { DatadogWebpackPlugin } from './webpack-plugin';

describe('runtime dependency copying', () => {
  it('is delegated to the packager by default for Vite', () => {
    expect(datadogVitePlugin().writeBundle).toBeUndefined();
    expect(datadogVitePlugin({ copyRuntimeDependencies: true }).writeBundle).toBeTypeOf('function');
  });

  it('is delegated to the packager by default for esbuild', () => {
    const defaultOnEnd = vi.fn();
    datadogEsbuildPlugin().setup({ initialOptions: {}, onEnd: defaultOnEnd });
    expect(defaultOnEnd).not.toHaveBeenCalled();

    const pluginCopyOnEnd = vi.fn();
    datadogEsbuildPlugin({ copyRuntimeDependencies: true }).setup({
      initialOptions: {},
      onEnd: pluginCopyOnEnd,
    });
    expect(pluginCopyOnEnd).toHaveBeenCalledOnce();
  });

  it('is delegated to the packager by default for webpack', () => {
    let defaultAfterEmitCalls = 0;
    new DatadogWebpackPlugin().apply(
      createWebpackCompiler(() => {
        defaultAfterEmitCalls += 1;
      })
    );
    expect(defaultAfterEmitCalls).toBe(0);

    let pluginCopyAfterEmitCalls = 0;
    new DatadogWebpackPlugin({ copyRuntimeDependencies: true }).apply(
      createWebpackCompiler(() => {
        pluginCopyAfterEmitCalls += 1;
      })
    );
    expect(pluginCopyAfterEmitCalls).toBe(1);
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
