import { beforeEach, describe, expect, it, vi } from 'vitest';

import { datadogEsbuildPlugin } from './esbuild-plugin';
import { datadogVitePlugin } from './vite-plugin';
import { DatadogWebpackPlugin } from './webpack-plugin';
import { copyRuntimeDependencies } from './copyRuntimeDependencies';

vi.mock('./copyRuntimeDependencies', () => ({ copyRuntimeDependencies: vi.fn() }));

describe('runtime dependency copying', () => {
  beforeEach(() => {
    vi.mocked(copyRuntimeDependencies).mockReset();
  });

  it.each(['vite', 'esbuild', 'webpack'] as const)(
    'propagates copy failures through the %s build hook',
    async (bundler) => {
      const error = new Error('Failed to copy runtime package');
      vi.mocked(copyRuntimeDependencies).mockRejectedValueOnce(error);
      let buildFinished: () => Promise<void>;
      switch (bundler) {
        case 'vite':
          buildFinished = () => datadogVitePlugin({ copyRuntimeDependencies: true }).writeBundle!({ dir: '/output' });
          break;
        case 'esbuild':
          datadogEsbuildPlugin({ copyRuntimeDependencies: true }).setup({
            initialOptions: { outdir: '/output' },
            onEnd(callback) {
              buildFinished = callback;
            },
          });
          break;
        case 'webpack':
          new DatadogWebpackPlugin({ copyRuntimeDependencies: true }).apply(
            createWebpackCompiler((_name, callback) => {
              buildFinished = () => callback({ outputOptions: { path: '/output' } });
            })
          );
          break;
      }
      await expect(buildFinished!()).rejects.toBe(error);
      expect(copyRuntimeDependencies).toHaveBeenCalledWith('/output', expect.any(Function));
    }
  );

  it('uses the esbuild outfile directory when outdir is absent', async () => {
    let buildFinished: () => Promise<void>;
    datadogEsbuildPlugin({ copyRuntimeDependencies: true }).setup({
      initialOptions: { outfile: 'output/main.js' },
      onEnd(callback) {
        buildFinished = callback;
      },
    });
    await buildFinished!();
    expect(copyRuntimeDependencies).toHaveBeenCalledWith('output', expect.any(Function));
  });

  it('does not copy when Vite or esbuild has no output directory', async () => {
    await datadogVitePlugin({ copyRuntimeDependencies: true }).writeBundle!({});
    let buildFinished: () => Promise<void>;
    datadogEsbuildPlugin({ copyRuntimeDependencies: true }).setup({
      initialOptions: {},
      onEnd(callback) {
        buildFinished = callback;
      },
    });
    await buildFinished!();
    expect(copyRuntimeDependencies).not.toHaveBeenCalled();
  });

  it('is disabled by default and can be enabled for Vite', () => {
    const plugin = datadogVitePlugin();
    expect(plugin.writeBundle).toBeUndefined();
    const externals = plugin.config!().build.rollupOptions.external;
    expect(externals.some((pattern) => pattern.test('dd-trace-electron'))).toBe(true);
    expect(externals.some((pattern) => pattern.test('dd-trace-electron/package.json'))).toBe(true);
    expect(externals.some((pattern) => pattern.test('dd-trace'))).toBe(false);
    expect(datadogVitePlugin({ copyRuntimeDependencies: true }).writeBundle).toBeTypeOf('function');
  });

  it('is disabled by default and can be enabled for esbuild', () => {
    const defaultOnEnd = vi.fn();
    const initialOptions = { external: [] as string[] };
    datadogEsbuildPlugin().setup({ initialOptions, onEnd: defaultOnEnd });
    expect(defaultOnEnd).not.toHaveBeenCalled();
    expect(initialOptions.external).toEqual(['dd-trace-electron', '@datadog/electron-sdk']);

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

  it('keeps dd-trace-electron external and excludes it from Webpack asset relocation without copying', () => {
    const compiler = createWebpackCompiler(vi.fn());
    const rule = {
      use: '@vercel/webpack-asset-relocator-loader',
      exclude: undefined as RegExp | undefined,
    };
    compiler.options.module.rules.push(rule);

    new DatadogWebpackPlugin().apply(compiler);

    const externals = compiler.options.externals as RegExp[];
    expect(externals.some((pattern) => pattern.test('dd-trace-electron'))).toBe(true);
    expect(externals.some((pattern) => pattern.test('dd-trace-electron/package.json'))).toBe(true);
    expect(externals.some((pattern) => pattern.test('dd-trace'))).toBe(false);
    expect(rule.exclude!.test('/app/node_modules/dd-trace-electron/index.js')).toBe(true);
    expect(rule.exclude!.test('C:\\app\\node_modules\\dd-trace-electron\\index.js')).toBe(true);
  });
});

function createWebpackCompiler(
  afterEmit: Parameters<DatadogWebpackPlugin['apply']>[0]['hooks']['afterEmit']['tapPromise']
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
        tapPromise(name, callback) {
          afterEmit(name, callback);
        },
      },
    },
  };
}
