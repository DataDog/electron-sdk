import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { channel } from 'node:diagnostics_channel';
import { runInNewContext } from 'node:vm';
import { expect, it, vi } from 'vitest';
import { DatadogWebpackPlugin } from './webpack-plugin';

interface ResolvedModule {
  request: string;
  createData: {
    resource: string;
    loaders?: { loader: string; options: Record<string, unknown> }[];
  };
}

it.each([false, true])(
  'publishes bundled CommonJS exports through the tracer loader with bundledMode=%s',
  async (bundledMode) => {
    const directory = await mkdtemp(join(tmpdir(), 'electron-webpack-instrumentation-'));
    const exported = channel('dd-trace:bundler:load');
    const messages: unknown[] = [];
    const collect = (message: unknown) => messages.push(message);
    try {
      // A registered package identity exercises the real loader without installing a test integration.
      const packageDirectory = join(directory, 'node_modules/dd-trace-api');
      await mkdir(packageDirectory, { recursive: true });
      await writeFile(
        join(packageDirectory, 'package.json'),
        JSON.stringify({ name: 'dd-trace-api', version: '1.0.1', type: 'commonjs' })
      );
      const resource = join(packageDirectory, 'index.js');
      const source = 'module.exports = { marker: "bundled-module" };';
      await writeFile(resource, source);

      let resolveModule: ((data: ResolvedModule) => void) | undefined;
      let checkEnvironment: (() => void) | undefined;
      const compiler = {
        options: { module: { rules: [] }, optimization: { minimize: true } },
        webpack: {
          BannerPlugin: class {
            apply = vi.fn();
          },
        },
        hooks: {
          afterEmit: { tap: vi.fn() },
          environment: {
            tap: (_name: string, callback: () => void) => {
              checkEnvironment = callback;
            },
          },
          thisCompilation: { tap: vi.fn() },
          normalModuleFactory: {
            tap: (
              _name: string,
              callback: (factory: {
                hooks: { afterResolve: { tap: (name: string, callback: (data: ResolvedModule) => void) => void } };
              }) => void
            ) => {
              callback({
                hooks: {
                  afterResolve: {
                    tap: (_name, callback) => {
                      resolveModule = callback;
                    },
                  },
                },
              });
            },
          },
        },
      };
      new DatadogWebpackPlugin({ bundledMode }).apply(compiler);
      expect(compiler.options.optimization.minimize).toBe(false);
      expect(checkEnvironment).toBeTypeOf('function');
      expect(() => checkEnvironment!()).not.toThrow();

      const resolved: ResolvedModule = { request: 'dd-trace-api', createData: { resource } };
      expect(resolveModule).toBeTypeOf('function');
      resolveModule!(resolved);
      expect(resolved.createData.loaders).toHaveLength(1);
      const instrumentation = resolved.createData.loaders![0];
      expect(instrumentation.options).toMatchObject({ pkg: 'dd-trace-api', version: '1.0.1' });

      const requireFn = createRequire(import.meta.url);
      const loader = requireFn(instrumentation.loader) as (
        this: {
          cacheable: (enabled: boolean) => void;
          getOptions: () => Record<string, unknown>;
          resourcePath: string;
          callback: (error: Error | null, code: string) => void;
        },
        source: string
      ) => void;
      let instrumented = '';
      loader.call(
        {
          cacheable: vi.fn(),
          getOptions: () => instrumentation.options,
          resourcePath: resource,
          callback: (error, code) => {
            expect(error).toBeNull();
            instrumented = code;
          },
        },
        source
      );

      exported.subscribe(collect);
      const module = { exports: {} };
      runInNewContext(instrumented, { module, require: requireFn });
      expect(module.exports).toEqual({ marker: 'bundled-module' });
      expect(messages).toEqual([
        {
          module: module.exports,
          version: '1.0.1',
          package: 'dd-trace-api',
          path: 'dd-trace-api',
        },
      ]);
    } finally {
      exported.unsubscribe(collect);
      await rm(directory, { recursive: true, force: true });
    }
  }
);
