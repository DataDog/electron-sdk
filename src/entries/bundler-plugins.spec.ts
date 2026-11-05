import { describe, expect, it, vi } from 'vitest';

import { datadogEsbuildPlugin } from './esbuild-plugin';
import { datadogVitePlugin } from './vite-plugin';
import { DatadogWebpackPlugin } from './webpack-plugin';

describe('runtime dependency copying', () => {
  it('is disabled by default and can be enabled for Vite', () => {
    const plugin = datadogVitePlugin();
    expect(plugin.writeBundle).toBeUndefined();
    const externals = plugin.config!().build.rollupOptions.external;
    expect(externals.some((pattern) => pattern.test('dd-trace-electron'))).toBe(false);
    expect(externals.some((pattern) => pattern.test('dd-trace-electron/package.json'))).toBe(false);
    expect(externals.some((pattern) => pattern.test('dd-trace'))).toBe(false);
    expect(datadogVitePlugin({ copyRuntimeDependencies: true }).writeBundle).toBeTypeOf('function');
  });

  it('is disabled by default and can be enabled for esbuild', () => {
    const defaultOnEnd = vi.fn();
    const initialOptions = { external: [] as string[] };
    datadogEsbuildPlugin().setup({ initialOptions, onEnd: defaultOnEnd });
    expect(defaultOnEnd).not.toHaveBeenCalled();
    expect(initialOptions.external).toEqual(['@datadog/electron-sdk']);

    const pluginCopyOnEnd = vi.fn();
    datadogEsbuildPlugin({ copyRuntimeDependencies: true }).setup({
      initialOptions: {},
      onEnd: pluginCopyOnEnd,
    });
    expect(pluginCopyOnEnd).toHaveBeenCalledOnce();
  });

  it('is disabled by default and can be enabled for webpack', () => {
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

  it('keeps the SDK external and excludes it from Webpack asset relocation without copying', () => {
    const compiler = createWebpackCompiler(vi.fn());
    const rule = {
      use: '@vercel/webpack-asset-relocator-loader',
      exclude: undefined as RegExp | undefined,
    };
    compiler.options.module.rules.push(rule);

    new DatadogWebpackPlugin().apply(compiler);

    const externals = compiler.options.externals as RegExp[];
    expect(externals.some((pattern) => pattern.test('dd-trace-electron'))).toBe(false);
    expect(externals.some((pattern) => pattern.test('dd-trace-electron/package.json'))).toBe(false);
    expect(externals.some((pattern) => pattern.test('dd-trace'))).toBe(false);
    expect(rule.exclude!.test('/app/node_modules/@datadog/electron-sdk/dist/index.cjs')).toBe(true);
    expect(rule.exclude!.test('C:\\app\\node_modules\\@datadog\\electron-sdk\\dist\\index.cjs')).toBe(true);
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
