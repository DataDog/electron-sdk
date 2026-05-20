/**
 * esbuild plugin for Electron apps using the Datadog Electron SDK.
 *
 * This plugin handles dd-trace initialization and dependency externalization
 * for both CJS and ESM esbuild output formats.
 *
 * For CJS output: prepends a banner that initializes dd-trace via require()
 * before any application code. dd-trace hooks require('electron') to wrap
 * BrowserWindow with automatic preload injection.
 *
 * For ESM output: prepends a banner that initializes dd-trace and registers
 * dd-trace's preload script directly via session.registerPreloadScript().
 * In ESM, static imports are loaded before any module code evaluates, so
 * dd-trace's IITM hooks cannot intercept `import 'electron'` for automatic
 * BrowserWindow wrapping. The direct preload registration achieves the same
 * result using dd-trace's preload script.
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

const DD_TRACE_PRELOAD = 'dd-trace/packages/datadog-instrumentations/src/electron/preload.js';

const CJS_BANNER = 'try{require("@datadog/electron-sdk/instrument")}catch{}';

// ESM banner: initialize dd-trace and register the preload script directly.
// IITM cannot wrap BrowserWindow in ESM because static imports are loaded
// before module code evaluates, so we register the preload via session API.
const ESM_BANNER = `
import { createRequire as __ddCR } from "module";
try {
  const __ddR = __ddCR(import.meta.url);
  __ddR("@datadog/electron-sdk/instrument");
  const __ddP = __ddR.resolve("${DD_TRACE_PRELOAD}");
  const { app: __ddApp, session: __ddSes } = __ddR("electron");
  const __ddReg = () => {
    try {
      __ddSes.defaultSession.registerPreloadScript({ type: "frame", filePath: __ddP });
    } catch {}
  };
  if (__ddApp.isReady()) __ddReg();
  else __ddApp.once("ready", __ddReg);
} catch {}
`.trim();

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
