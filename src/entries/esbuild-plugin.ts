/**
 * esbuild plugin for Electron apps using the Datadog Electron SDK.
 *
 * This plugin handles early Electron instrumentation for both CJS and ESM
 * output, bundles the Electron SDK, and keeps dd-trace external.
 *
 * It emits self-contained instrumentation and preload assets, then prepends a
 * format-appropriate loader for the instrumentation asset to the application entry.
 *
 * Usage:
 *   import { datadogEsbuildPlugin } from '@datadog/electron-sdk/esbuild-plugin';
 *
 *   await esbuild.build({
 *     plugins: [datadogEsbuildPlugin()],
 *   });
 */

import { createRequire } from 'node:module';
import { cpSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { DatadogBundlerPluginOptions } from './bundler-plugin-options';
import { createInstrumentationBanner, emitSdkRuntimeAssets } from './sdk-runtime-assets';

export type { DatadogBundlerPluginOptions } from './bundler-plugin-options';

interface EsbuildPlugin {
  name: string;
  setup: (build: {
    initialOptions: {
      format?: string;
      banner?: { js?: string };
      external?: string[];
      outdir?: string;
      outfile?: string;
    };
    onEnd: (cb: () => void) => void;
  }) => void;
}

/**
 * Creates the Datadog esbuild plugin.
 *
 * @example
 * plugins: [datadogEsbuildPlugin({ copyRuntimeDependencies: false })]
 */
export function datadogEsbuildPlugin(pluginOptions: DatadogBundlerPluginOptions = {}): EsbuildPlugin {
  return {
    name: 'datadog-electron-sdk',
    setup(build) {
      const isESM = build.initialOptions.format === 'esm';
      const ddBanner = createInstrumentationBanner(isESM ? 'esm' : 'cjs');

      // Prepend the Electron instrumentation banner
      const existingBanner = build.initialOptions.banner?.js;
      build.initialOptions.banner = {
        ...build.initialOptions.banner,
        js: existingBanner ? `${existingBanner}\n${ddBanner}` : ddBanner,
      };

      // Keep dd-trace external; the Electron SDK itself is bundled into the application.
      const external = build.initialOptions.external ?? [];
      for (const pkg of ['dd-trace']) {
        if (!external.includes(pkg)) {
          external.push(pkg);
        }
      }
      build.initialOptions.external = external;

      const currentFile = typeof __filename !== 'undefined' ? __filename : fileURLToPath(import.meta.url);
      const _require = createRequire(currentFile);

      build.onEnd(() => {
        const outDir =
          build.initialOptions.outdir ??
          (build.initialOptions.outfile ? dirname(build.initialOptions.outfile) : undefined);
        if (!outDir) return;

        emitSdkRuntimeAssets(currentFile, outDir);
        if (pluginOptions.copyRuntimeDependencies === false) return;

        const destModules = join(outDir, 'node_modules');
        const visited = new Set<string>();

        function copyPackageTree(pkg: string): void {
          if (visited.has(pkg)) return;
          visited.add(pkg);

          try {
            const entryPath = _require.resolve(pkg);
            let pkgDir = dirname(entryPath);
            while (pkgDir !== dirname(pkgDir) && !existsSync(join(pkgDir, 'package.json'))) {
              pkgDir = dirname(pkgDir);
            }

            const destDir = join(destModules, pkg);
            if (!existsSync(destDir)) {
              mkdirSync(dirname(destDir), { recursive: true });
              cpSync(pkgDir, destDir, { recursive: true });
            }

            const pkgJson = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as {
              dependencies?: Record<string, string>;
            };
            for (const dep of Object.keys(pkgJson.dependencies ?? {})) {
              copyPackageTree(dep);
            }
          } catch {
            console.warn(`[datadog] Failed to copy package '${pkg}' to build output`);
          }
        }

        copyPackageTree('dd-trace');
      });
    },
  };
}
