/**
 * Vite plugin for Electron apps using the Datadog Electron SDK.
 *
 * Vite hoists all top-level `require()` calls to the start of the bundle,
 * regardless of their source module order. This breaks Electron instrumentation
 * because `require('electron')` runs before `@datadog/electron-sdk/instrument`.
 *
 * This plugin:
 * 1. Keeps the SDK external by default; bundledMode inlines it and emits runtime assets.
 * 2. Prepends SDK instrumentation (via @datadog/electron-sdk/instrument)
 *    to the very top of the main process entry chunk, before any hoisted
 *    requires. No manual import needed.
 * 3. Copies @datadog/electron-sdk and its runtime dependencies
 *    into the build output's node_modules only when `copyRuntimeDependencies: true`.
 *    Copying is disabled by default; the application packager must stage them.
 *    dd-trace-electron stays external unless bundledMode is enabled.
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

import { createInstrumentationBanner, emitSdkRuntimeAssets } from './sdk-runtime-assets';
import { createBundledModeBanner } from './tracer-runtime';
import type { DatadogBundlerPluginOptions } from './bundler-plugin-options';

export type { DatadogBundlerPluginOptions } from './bundler-plugin-options';

interface VitePlugin {
  name: string;
  config?: () => { build: { rollupOptions: { external: RegExp[] } } };
  renderChunk?: (
    code: string,
    chunk: { isEntry: boolean; fileName?: string },
    options: { format: string }
  ) => string | null;
  writeBundle?: (options: { dir?: string }) => void;
}

const CJS_BANNER =
  'try { require("node:module").createRequire(__filename)("@datadog/electron-sdk/instrument"); } catch {}';

// ESM modules don't have a global require, so we use createRequire to load instrument.ts,
// which handles defaultSession preload registration via patchBrowserWindow.
const ESM_BANNER = `
import { createRequire as __ddCR } from "module";
try { __ddCR(import.meta.url)("@datadog/electron-sdk/instrument"); } catch {}
`.trim();

/**
 * Creates the Datadog Vite plugin.
 *
 * @example
 * plugins: [datadogVitePlugin()]
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
            external:
              pluginOptions.bundledMode === true ? [] : [/^@datadog\/electron-sdk/, /^dd-trace-electron(?:\/|$)/],
          },
        },
      };
    },
    renderChunk(code, chunk, options) {
      if (!chunk.isEntry) return null;
      if (pluginOptions.bundledMode === true) {
        return `${createInstrumentationBanner(options.format === 'es' ? 'esm' : 'cjs', chunk.fileName)}\n${code}`;
      }
      const banner = options.format === 'es' ? ESM_BANNER : CJS_BANNER;
      return `${createBundledModeBanner(pluginOptions.bundledMode, options.format === 'es' ? 'esm' : 'cjs')}\n${banner}\n${code}`;
    },
  };

  if (pluginOptions.bundledMode !== true && pluginOptions.copyRuntimeDependencies !== true) return plugin;

  plugin.writeBundle = (outputOptions) => {
    // Copy externalized packages and their transitive dependencies into
    // node_modules alongside the bundle output so they are available at
    // runtime in packaged apps (e.g. Electron Forge asars) where the
    // project's node_modules is not included.
    const outDir = outputOptions.dir;
    if (!outDir) return;
    if (pluginOptions.bundledMode === true) {
      emitSdkRuntimeAssets(currentFile, outDir);
      return;
    }

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

    copyPackageTree('@datadog/electron-sdk');
  };

  return plugin;
}
