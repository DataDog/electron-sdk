/**
 * Vite plugin for Electron apps using the Datadog Electron SDK.
 *
 * Vite hoists all top-level `require()` calls to the start of the bundle,
 * regardless of their source module order. This breaks Electron instrumentation
 * because `require('electron')` runs before `@datadog/electron-sdk/instrument`.
 *
 * This plugin:
 * 1. Externalizes dd-trace while allowing the Electron SDK to be bundled.
 * 2. Prepends a loader for the emitted SDK instrumentation to the main process
 *    entry chunk, before any hoisted requires. No manual import is needed.
 * 3. Emits self-contained instrumentation and preload assets, and optionally
 *    copies dd-trace's runtime dependency tree for packagers that do not stage it.
 *
 * Usage:
 *   import { datadogVitePlugin } from '@datadog/electron-sdk/vite-plugin';
 *
 *   export default defineConfig({
 *     plugins: [datadogVitePlugin()],
 *   });
 */

import { createRequire } from 'node:module';
import { readFileSync, cpSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { DatadogBundlerPluginOptions } from './bundler-plugin-options';
import { createInstrumentationBanner, emitSdkRuntimeAssets } from './sdk-runtime-assets';

export type { DatadogBundlerPluginOptions } from './bundler-plugin-options';

interface VitePlugin {
  name: string;
  config?: () => { build: { rollupOptions: { external: RegExp[] } } };
  renderChunk?: (
    code: string,
    chunk: { isEntry: boolean; fileName: string },
    options: { format: string }
  ) => string | null;
  writeBundle?: (options: { dir?: string }) => void;
}

/**
 * Creates the Datadog Vite plugin.
 *
 * @example
 * plugins: [datadogVitePlugin({ copyRuntimeDependencies: false })]
 */
export function datadogVitePlugin(pluginOptions: DatadogBundlerPluginOptions = {}): VitePlugin {
  // Support both CJS (__filename) and ESM (import.meta.url) contexts at build time
  const currentFile = typeof __filename !== 'undefined' ? __filename : fileURLToPath(import.meta.url);
  const _require = createRequire(currentFile);

  const plugin: VitePlugin = {
    name: 'datadog-electron-sdk',
    config() {
      return {
        build: {
          rollupOptions: {
            external: [/^dd-trace/],
          },
        },
      };
    },
    renderChunk(code, chunk, options) {
      if (!chunk.isEntry) return null;
      const banner = createInstrumentationBanner(options.format === 'es' ? 'esm' : 'cjs', chunk.fileName);
      return `${banner}\n${code}`;
    },
  };

  plugin.writeBundle = (outputOptions) => {
    const outDir = outputOptions.dir;
    if (!outDir) return;

    emitSdkRuntimeAssets(currentFile, outDir);
    if (pluginOptions.copyRuntimeDependencies === false) return;

    // dd-trace remains external and needs its runtime dependency tree staged
    // when the application packager does not handle external dependencies.
    const destModules = join(outDir, 'node_modules');
    const visited = new Set<string>();

    function copyPackageTree(pkg: string): void {
      if (visited.has(pkg)) return;
      visited.add(pkg);

      try {
        // Resolve the package's main entry, then walk up to find the root
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

        // Recursively copy runtime dependencies
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
  };

  return plugin;
}
