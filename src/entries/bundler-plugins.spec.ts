import { afterEach, describe, expect, it, vi } from 'vitest';

import { spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { getBundlerConfiguration, getTracerModule } from './tracer-runtime';
import { datadogEsbuildPlugin } from './esbuild-plugin';
import { datadogVitePlugin } from './vite-plugin';
import { DatadogWebpackPlugin } from './webpack-plugin';

const { applyTracingPlugin, setupTracingEsbuildPlugin } = vi.hoisted(() => ({
  applyTracingPlugin: vi.fn(),
  setupTracingEsbuildPlugin: vi.fn<ReturnType<typeof datadogEsbuildPlugin>['setup']>(),
}));

vi.mock('node:module', () => ({
  createRequire: () =>
    Object.assign(
      (id: string) => {
        if (id === 'dd-trace-electron/esbuild') return { name: 'datadog-esbuild', setup: setupTracingEsbuildPlugin };
        if (id !== 'dd-trace-electron/webpack') throw new Error(`Unexpected package: ${id}`);
        return class {
          apply = applyTracingPlugin;
        };
      },
      { resolve: (id: string) => `/packages/${id}/index.js` }
    ),
}));

vi.mock('node:fs', () => ({
  copyFileSync: vi.fn(),
  cpSync: vi.fn(),
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  readFileSync: vi.fn(),
}));

afterEach(() => vi.resetAllMocks());

describe('Webpack dependency instrumentation', () => {
  it.each([{}, { bundledMode: true }, { copyRuntimeDependencies: true }])(
    'applies the tracer plugin without requiring minifier configuration: %j',
    (options) => {
      const compiler = createWebpackCompiler(vi.fn());
      const optimization = { minimize: true, concatenateModules: true };
      compiler.options.optimization = optimization;

      new DatadogWebpackPlugin(options).apply(compiler);

      expect(applyTracingPlugin).toHaveBeenCalledExactlyOnceWith(compiler);
      expect(optimization).toEqual({ minimize: false, concatenateModules: true });
    }
  );

  it('disables the production minification default before the tracer plugin is applied', () => {
    const compiler = createWebpackCompiler(vi.fn());
    applyTracingPlugin.mockImplementation(() => {
      expect(compiler.options.optimization?.minimize).toBe(false);
    });

    new DatadogWebpackPlugin().apply(compiler);

    expect(applyTracingPlugin).toHaveBeenCalledOnce();
  });
});

describe('esbuild dependency instrumentation', () => {
  it.each([{}, { bundledMode: true }, { copyRuntimeDependencies: true }])(
    'configures runtime loading before applying the tracer plugin: %j',
    (options) => {
      const build = { initialOptions: { bundle: true }, onEnd: vi.fn() };
      setupTracingEsbuildPlugin.mockImplementation((configuredBuild) => {
        expect(configuredBuild.initialOptions.banner?.js).toContain('@datadog/electron-sdk:bundledMode');
        expect(configuredBuild.initialOptions.external).toEqual(
          options.bundledMode ? [] : ['@datadog/electron-sdk', 'dd-trace-electron']
        );
      });

      datadogEsbuildPlugin(options).setup(build);

      expect(setupTracingEsbuildPlugin).toHaveBeenCalledExactlyOnceWith(build);
    }
  );

  it.each([{ minify: true }, { minifyIdentifiers: true }])('preserves names before tracing setup: %j', (options) => {
    const build = { initialOptions: { bundle: true, keepNames: false, ...options }, onEnd: vi.fn() };
    setupTracingEsbuildPlugin.mockImplementation((configuredBuild) => {
      expect(configuredBuild.initialOptions.keepNames).toBe(true);
    });

    datadogEsbuildPlugin().setup(build);

    expect(setupTracingEsbuildPlugin).toHaveBeenCalledOnce();
    expect(build.initialOptions).toMatchObject(options);
  });

  it('preserves non-minifying options', () => {
    const build = { initialOptions: { bundle: true, keepNames: false }, onEnd: vi.fn() };
    datadogEsbuildPlugin().setup(build);
    expect(build.initialOptions.keepNames).toBe(false);
  });

  it.each([undefined, false])('leaves dependency loading to Node when bundle=%s', (bundle) => {
    const build = { initialOptions: { bundle }, onEnd: vi.fn() };
    datadogEsbuildPlugin().setup(build);
    expect(build.initialOptions).not.toHaveProperty('external');
    expect(build.initialOptions).toHaveProperty(
      'banner.js',
      expect.stringContaining('@datadog/electron-sdk/instrument')
    );
    expect(setupTracingEsbuildPlugin).not.toHaveBeenCalled();
    expect(build.onEnd).not.toHaveBeenCalled();
  });

  it.each([undefined, false])('rejects bundledMode without bundling: bundle=%s', (bundle) => {
    expect(() =>
      datadogEsbuildPlugin({ bundledMode: true }).setup({ initialOptions: { bundle }, onEnd: vi.fn() })
    ).toThrow('bundledMode requires esbuild bundle: true');
    expect(setupTracingEsbuildPlugin).not.toHaveBeenCalled();
  });
});

describe('runtime dependency copying', () => {
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
    const initialOptions = { bundle: true, external: [] as string[] };
    datadogEsbuildPlugin().setup({ initialOptions, onEnd: defaultOnEnd });
    expect(defaultOnEnd).not.toHaveBeenCalled();
    expect(initialOptions.external).toEqual(['@datadog/electron-sdk', 'dd-trace-electron']);

    const pluginCopyOnEnd = vi.fn();
    datadogEsbuildPlugin({ copyRuntimeDependencies: true }).setup({
      initialOptions: { bundle: true },
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
    expect(externals.some((pattern) => pattern.test('dd-trace-electron'))).toBe(true);
    expect(externals.some((pattern) => pattern.test('dd-trace-electron/package.json'))).toBe(true);
    expect(externals.some((pattern) => pattern.test('dd-trace'))).toBe(false);
    expect(rule.exclude!.test('/app/node_modules/@datadog/electron-sdk/dist/index.cjs')).toBe(true);
    expect(rule.exclude!.test('C:\\app\\node_modules\\@datadog\\electron-sdk\\dist\\index.cjs')).toBe(true);
  });
});

describe('runtime dependency copy selection', () => {
  it.each([false, true])('copies the tracer tree only in external mode (bundledMode=%s)', (bundledMode) => {
    vi.mocked(existsSync).mockImplementation((file) => {
      const path = String(file).split('\\').join('/');
      return path.endsWith('/package.json') && !path.endsWith('/dist/package.json');
    });
    vi.mocked(readFileSync).mockImplementation((file) => {
      const path = String(file).split('\\').join('/');
      if (path.includes('/dd-trace-electron/')) return JSON.stringify({ dependencies: { 'dc-polyfill': '*' } });
      if (path.includes('/dc-polyfill/')) return '{}';
      return JSON.stringify({ dependencies: { 'dd-trace-electron': '6.23.0' } });
    });
    const options = { bundledMode, copyRuntimeDependencies: true };
    const assertCopied = () => {
      const destinations = vi.mocked(cpSync).mock.calls.map(([, dest]) => String(dest).split('\\').join('/'));
      expect(destinations.some((file) => file.endsWith('/@datadog/electron-sdk'))).toBe(!bundledMode);
      expect(destinations.some((file) => file.endsWith('/dd-trace-electron'))).toBe(!bundledMode);
      expect(destinations.some((file) => file.endsWith('/dc-polyfill'))).toBe(!bundledMode);
      if (bundledMode) {
        const assets = vi.mocked(copyFileSync).mock.calls.map(([, dest]) => String(dest).split('\\').join('/'));
        expect(assets).toEqual([
          '/output/.datadog/instrument.cjs',
          '/output/.datadog/preload.js',
          '/output/.datadog/tracer.cjs',
          '/output/.datadog/tracer.LICENSE',
        ]);
      }
      vi.mocked(copyFileSync).mockClear();
      vi.mocked(cpSync).mockClear();
    };

    datadogVitePlugin(options).writeBundle!({ dir: '/output' });
    assertCopied();
    datadogEsbuildPlugin(options).setup({ initialOptions: { bundle: true, outdir: '/output' }, onEnd: (cb) => cb() });
    assertCopied();
    new DatadogWebpackPlugin(options).apply(
      createWebpackCompiler((_name, cb) => cb({ outputOptions: { path: '/output' } }))
    );
    assertCopied();
  });
});

describe('bundled mode', () => {
  afterEach(() => {
    delete (globalThis as Record<symbol, unknown>)[Symbol.for('@datadog/electron-sdk:bundledMode')];
    delete (globalThis as Record<symbol, unknown>)[Symbol.for('@datadog/electron-sdk:copyRuntimeDependencies')];
  });

  it.each([
    { bundledMode: false, copyRuntimeDependencies: false },
    { bundledMode: false, copyRuntimeDependencies: true },
    { bundledMode: true, copyRuntimeDependencies: false },
  ])('sets build options %j before static ESM instrumentation imports', (options) => {
    const { bundledMode, copyRuntimeDependencies } = options;
    const vite = datadogVitePlugin(options);
    const initialOptions = { bundle: true, format: 'esm', banner: { js: '' } };
    datadogEsbuildPlugin(options).setup({ initialOptions, onEnd: vi.fn() });
    for (const banner of [vite.renderChunk!('', { isEntry: true }, { format: 'es' })!, initialOptions.banner.js]) {
      const assertion = encodeURIComponent(
        `if(globalThis[Symbol.for('@datadog/electron-sdk:bundledMode')]!==${bundledMode} || globalThis[Symbol.for('@datadog/electron-sdk:copyRuntimeDependencies')]!==${copyRuntimeDependencies}) throw Error('Build options were set too late');`
      );
      // A static dependency reads the mode before the entry's body executes. Resolve the defensive
      // instrumentation require from an absent package tree so this check does not need build output.
      const source = `${banner
        .replace('import.meta.url', '"file:///uninstalled/main.mjs"')
        .replace('import "./.datadog/instrument.cjs";', `import "data:text/javascript,${assertion}";`)}
import "data:text/javascript,${assertion}";`;
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], { encoding: 'utf8' });
      expect(result.status, result.stderr).toBe(0);
    }
  });

  it.each([
    {},
    { bundledMode: false, copyRuntimeDependencies: false },
    { bundledMode: false, copyRuntimeDependencies: true },
    { bundledMode: true },
    { bundledMode: true, copyRuntimeDependencies: true },
  ])('selects effective build options %j before instrumentation in all plugins', (options) => {
    const { bundledMode, copyRuntimeDependencies } = options;
    const expectedModule = bundledMode === true ? './tracer.cjs' : 'dd-trace-electron';
    const assertBanner = (banner: string) => {
      const instrument = vi.fn((id: string) => {
        expect(id).toBe(bundledMode === true ? './.datadog/instrument.cjs' : '@datadog/electron-sdk/instrument');
        expect(getTracerModule()).toBe(expectedModule);
        expect(getBundlerConfiguration()).toEqual({
          bundledMode: bundledMode === true,
          copyRuntimeDependencies: bundledMode !== true && copyRuntimeDependencies === true,
        });
      });
      const requireFn = (id: string) => (id === 'node:module' ? { createRequire: () => instrument } : instrument(id));
      runInNewContext(banner, { globalThis, Symbol, require: requireFn, __filename: '/app/main.cjs' });
      expect(instrument).toHaveBeenCalledOnce();
    };

    const vite = datadogVitePlugin(options);
    const external = vite.config!().build.rollupOptions.external;
    expect(external.some((pattern) => pattern.test('dd-trace-electron'))).toBe(bundledMode !== true);
    expect(external.some((pattern) => pattern.test('@datadog/electron-sdk'))).toBe(bundledMode !== true);
    assertBanner(vite.renderChunk!('', { isEntry: true }, { format: 'cjs' })!);

    const initialOptions = { bundle: true, external: ['electron'], banner: { js: '' } };
    datadogEsbuildPlugin(options).setup({ initialOptions, onEnd: vi.fn() });
    expect(initialOptions.external.includes('dd-trace-electron')).toBe(bundledMode !== true);
    expect(initialOptions.external).toContain('electron');
    expect(initialOptions.external.includes('@datadog/electron-sdk')).toBe(bundledMode !== true);
    assertBanner(initialOptions.banner.js);

    const compiler = createWebpackCompiler(vi.fn(), assertBanner);
    new DatadogWebpackPlugin(options).apply(compiler);
    expect((compiler.options.externals as RegExp[]).some((pattern) => pattern.test('dd-trace-electron'))).toBe(
      bundledMode !== true
    );
    expect((compiler.options.externals as RegExp[]).some((pattern) => pattern.test('@datadog/electron-sdk'))).toBe(
      bundledMode !== true
    );
  });
});

function createWebpackCompiler(
  afterEmit: Parameters<DatadogWebpackPlugin['apply']>[0]['hooks']['afterEmit']['tap'],
  onBanner?: (banner: string) => void
): Parameters<DatadogWebpackPlugin['apply']>[0] {
  class BannerPlugin {
    constructor(options: { banner: string; raw: boolean; entryOnly: boolean }) {
      onBanner?.(options.banner);
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
