/**
 * esbuild plugin for Electron apps using the Datadog Electron SDK.
 *
 * This plugin handles dd-trace initialization and dependency externalization
 * for both CJS and ESM esbuild output formats.
 *
 * For CJS output: prepends a banner that initializes dd-trace via require()
 * before any application code.
 *
 * For ESM output: prepends a banner that initializes dd-trace and registers
 * the SDK's preload script directly via session.registerPreloadScript().
 * In ESM, static imports are loaded before any module code evaluates, so
 * BrowserWindow subclassing alone cannot intercept `import 'electron'`.
 * The direct preload registration achieves the same result.
 *
 * Also copies dd-trace and @datadog/electron-sdk into the build output's
 * node_modules so they are available at runtime in packaged apps.
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
    onEnd: (callback: () => void | Promise<void>) => void;
  }) => void;
}

const SDK_PRELOAD = '@datadog/electron-sdk/electron/preload';

const CJS_BANNER = 'try{require("@datadog/electron-sdk/instrument")}catch{}';

// ESM banner: initialize dd-trace and register the SDK's preload script directly.
// IITM cannot wrap BrowserWindow in ESM because static imports are loaded
// before module code evaluates, so we register the preload via session API.
const ESM_BANNER = `
import { createRequire as __ddCR } from "module";
try {
  const __ddR = __ddCR(import.meta.url);
  __ddR("@datadog/electron-sdk/instrument");
  const __ddP = __ddR.resolve("${SDK_PRELOAD}");
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
  const currentFile = typeof __filename !== 'undefined' ? __filename : fileURLToPath(import.meta.url);
  const _require = createRequire(currentFile);

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

      // Copy externalized packages into node_modules alongside the output
      // so they are available at runtime in packaged apps
      build.onEnd(() => {
        const outDir =
          build.initialOptions.outdir ??
          (build.initialOptions.outfile ? dirname(build.initialOptions.outfile) : undefined);
        if (!outDir) return;

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
              optionalDependencies?: Record<string, string>;
            };
            for (const dep of Object.keys({
              ...pkgJson.dependencies,
              ...pkgJson.optionalDependencies,
            })) {
              copyPackageTree(dep);
            }
          } catch {
            console.warn(`[datadog] Failed to copy package '${pkg}' to build output`);
          }
        }

        copyPackageTree('dd-trace');
        copyPackageTree('@datadog/electron-sdk');
      });
    },
  };
}
