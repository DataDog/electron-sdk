/**
 * Vite plugin for Electron apps using the Datadog Electron SDK.
 *
 * Vite hoists all top-level `require()` calls to the start of the bundle,
 * regardless of their source module order. This breaks Electron instrumentation
 * because `require('electron')` runs before `@datadog/electron-sdk/instrument`.
 *
 * This plugin:
 * 1. Externalizes dd-trace-electron and the electron-sdk so they remain as runtime
 *    requires (not bundled), preserving runtime instrumentation.
 * 2. Prepends SDK instrumentation (via @datadog/electron-sdk/instrument)
 *    to the very top of the main process entry chunk, before any hoisted
 *    requires. No manual import needed.
 * 3. Copies dd-trace-electron, @datadog/electron-sdk, and their runtime dependencies
 *    into the build output's node_modules only when `copyRuntimeDependencies: true`.
 *    Copying is disabled by default; the application packager must stage them.
 *
 * Usage:
 *   import { datadogVitePlugin } from '@datadog/electron-sdk/vite-plugin';
 *
 *   export default defineConfig({
 *     plugins: [datadogVitePlugin()],
 *   });
 */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { copyRuntimeDependencies } from './copyRuntimeDependencies';

import type { DatadogBundlerPluginOptions } from './bundler-plugin-options';

export type { DatadogBundlerPluginOptions } from './bundler-plugin-options';

interface VitePlugin {
  name: string;
  config?: () => { build: { rollupOptions: { external: RegExp[] } } };
  renderChunk?: (code: string, chunk: { isEntry: boolean }, options: { format: string }) => string | null;
  writeBundle?: (options: { dir?: string }) => Promise<void>;
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
            external: [/^dd-trace-electron/, /^@datadog\/electron-sdk/],
          },
        },
      };
    },
    renderChunk(code, chunk, options) {
      if (!chunk.isEntry) return null;
      const banner = options.format === 'es' ? ESM_BANNER : CJS_BANNER;
      return `${banner}\n${code}`;
    },
  };

  if (pluginOptions.copyRuntimeDependencies !== true) return plugin;

  plugin.writeBundle = async (outputOptions) => {
    if (outputOptions.dir) await copyRuntimeDependencies(outputOptions.dir, _require);
  };

  return plugin;
}
