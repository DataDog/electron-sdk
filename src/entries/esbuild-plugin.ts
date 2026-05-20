/**
 * esbuild plugin for Electron apps using the Datadog Electron SDK.
 *
 * esbuild hoists ESM `import` statements before any module body code, so
 * `import '@datadog/electron-sdk/instrument'` in source cannot guarantee
 * execution before `import 'electron'`. This plugin:
 *
 * 1. Prepends a banner that initializes dd-trace via a synchronous require()
 *    call, which runs in the module body before application code.
 *
 * 2. Externalizes dd-trace and @datadog/electron-sdk so they remain as
 *    runtime requires (not bundled), preserving dd-trace's dynamic requires
 *    and native module loading.
 *
 * Usage:
 *   import { datadogEsbuildPlugin } from '@datadog/electron-sdk/esbuild-plugin';
 *
 *   await esbuild.build({
 *     plugins: [datadogEsbuildPlugin()],
 *   });
 */

interface EsbuildPlugin {
  name: string;
  setup: (build: {
    initialOptions: {
      format?: string;
      banner?: { js?: string };
      external?: string[];
    };
  }) => void;
}

const CJS_BANNER = 'try{require("@datadog/electron-sdk/instrument")}catch{}';
const ESM_BANNER = [
  'import{createRequire as __ddCR}from"module";',
  'try{__ddCR(import.meta.url)("@datadog/electron-sdk/instrument")}catch{}',
].join('');

export function datadogEsbuildPlugin(): EsbuildPlugin {
  return {
    name: 'datadog-electron-sdk',
    setup(build) {
      const isESM = build.initialOptions.format === 'esm';
      const ddBanner = isESM ? ESM_BANNER : CJS_BANNER;

      // Prepend dd-trace initialization banner
      const existingBanner = build.initialOptions.banner?.js;
      build.initialOptions.banner = {
        ...build.initialOptions.banner,
        js: existingBanner ? `${existingBanner}\n${ddBanner}` : ddBanner,
      };

      // Externalize dd-trace and @datadog/electron-sdk
      const external = build.initialOptions.external ?? [];
      for (const pkg of ['dd-trace', '@datadog/electron-sdk']) {
        if (!external.includes(pkg)) {
          external.push(pkg);
        }
      }
      build.initialOptions.external = external;
    },
  };
}
