/**
 * Vite plugin for Electron apps using the Datadog Electron SDK.
 *
 * Vite hoists all top-level `require()` calls to the start of the bundle,
 * regardless of their source module order. This breaks dd-trace's module
 * hooking because `require('electron')` runs before dd-trace can register
 * its hooks via `import '@datadog/electron-sdk/instrument'`.
 *
 * This plugin:
 * 1. Externalizes dd-trace and the electron-sdk so they remain as runtime
 *    requires (not bundled), preserving module hook mechanics.
 * 2. Prepends dd-trace initialization (via @datadog/electron-sdk/instrument)
 *    to the very top of the main process entry chunk, ensuring hooks are
 *    registered before any hoisted requires. No manual import needed.
 * 3. For ESM output, also registers the SDK's preload script via
 *    session.registerPreloadScript(), since static imports are hoisted before
 *    banner code and BrowserWindow subclassing alone cannot guarantee the
 *    preload runs for windows opened before app.ready.
 * 4. Copies dd-trace and @datadog/electron-sdk into the build output's
 *    node_modules so they are available at runtime in packaged apps.
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

interface VitePlugin {
  name: string;
  config?: () => { build: { rollupOptions: { external: RegExp[] } } };
  renderChunk?: (code: string, chunk: { isEntry: boolean }, options: { format: string }) => string | null;
  writeBundle?: (options: { dir?: string }) => void;
}

const SDK_PRELOAD = '@datadog/electron-sdk/electron/preload';

const CJS_BANNER =
  'try { require("node:module").createRequire(__filename)("@datadog/electron-sdk/instrument"); } catch {}';

// ESM banner: initialize dd-trace and register the SDK's preload script directly.
// In ESM, static imports are loaded before module code evaluates, so dd-trace's
// IITM hooks cannot intercept `import 'electron'` for automatic BrowserWindow
// wrapping. The direct preload registration achieves the same result.
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

export function datadogVitePlugin(): VitePlugin {
  // Support both CJS (__filename) and ESM (import.meta.url) contexts at build time
  const currentFile = typeof __filename !== 'undefined' ? __filename : fileURLToPath(import.meta.url);
  const _require = createRequire(currentFile);

  return {
    name: 'datadog-electron-sdk',
    config() {
      return {
        build: {
          rollupOptions: {
            external: [/^dd-trace/, /^@datadog\/electron-sdk/],
          },
        },
      };
    },
    renderChunk(code, chunk, options) {
      if (!chunk.isEntry) return null;
      const banner = options.format === 'es' ? ESM_BANNER : CJS_BANNER;
      return `${banner}\n${code}`;
    },
    writeBundle(options) {
      // Copy externalized packages and their transitive dependencies into
      // node_modules alongside the bundle output so they are available at
      // runtime in packaged apps (e.g. Electron Forge asars) where the
      // project's node_modules is not included.
      const outDir = options.dir;
      if (!outDir) return;

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
    },
  };
}
