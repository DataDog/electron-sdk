/**
 * esbuild plugin for Electron apps using the Datadog Electron SDK.
 *
 * This plugin:
 * 1. Externalizes dd-trace-electron and @datadog/electron-sdk so they remain as runtime
 *    dependencies instead of being bundled.
 * 2. Prepends a banner that loads @datadog/electron-sdk/instrument before the
 *    main entry, using require for CJS output and createRequire for ESM output.
 *    This registers the SDK preload and patches BrowserWindow for automatic
 *    preload injection.
 * 3. Copies dd-trace-electron, @datadog/electron-sdk, and their runtime dependencies
 *    into the build output's node_modules only when `copyRuntimeDependencies: true`.
 *    Copying is disabled by default; the application packager must stage them.
 *
 * Usage:
 *   import { datadogEsbuildPlugin } from '@datadog/electron-sdk/esbuild-plugin';
 *
 *   await esbuild.build({
 *     plugins: [datadogEsbuildPlugin()],
 *   });
 */

import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { copyRuntimeDependencies } from './copyRuntimeDependencies';

import type { DatadogBundlerPluginOptions } from './bundler-plugin-options';

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
    onEnd: (cb: () => Promise<void>) => void;
  }) => void;
}

const CJS_BANNER = 'try{require("@datadog/electron-sdk/instrument")}catch{}';

// ESM modules don't have a global require, so we use createRequire to load instrument.ts,
// which handles defaultSession preload registration via patchBrowserWindow.
const ESM_BANNER = `
import { createRequire as __ddCR } from "module";
try { __ddCR(import.meta.url)("@datadog/electron-sdk/instrument"); } catch {}
`.trim();

/**
 * Creates the Datadog esbuild plugin.
 *
 * @example
 * plugins: [datadogEsbuildPlugin()]
 */
export function datadogEsbuildPlugin(pluginOptions: DatadogBundlerPluginOptions = {}): EsbuildPlugin {
  return {
    name: 'datadog-electron-sdk',
    setup(build) {
      const isESM = build.initialOptions.format === 'esm';
      const ddBanner = isESM ? ESM_BANNER : CJS_BANNER;

      // Prepend the Electron instrumentation banner
      const existingBanner = build.initialOptions.banner?.js;
      build.initialOptions.banner = {
        ...build.initialOptions.banner,
        js: existingBanner ? `${existingBanner}\n${ddBanner}` : ddBanner,
      };

      // Externalize dd-trace-electron and @datadog/electron-sdk
      const external = build.initialOptions.external ?? [];
      for (const pkg of ['dd-trace-electron', '@datadog/electron-sdk']) {
        if (!external.includes(pkg)) {
          external.push(pkg);
        }
      }
      build.initialOptions.external = external;

      if (pluginOptions.copyRuntimeDependencies !== true) return;

      const currentFile = typeof __filename !== 'undefined' ? __filename : fileURLToPath(import.meta.url);
      const _require = createRequire(currentFile);

      build.onEnd(async () => {
        const outDir =
          build.initialOptions.outdir ??
          (build.initialOptions.outfile ? dirname(build.initialOptions.outfile) : undefined);
        if (outDir) await copyRuntimeDependencies(outDir, _require);
      });
    },
  };
}
