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
 * 2. Prepends the dd-trace initialization to the very top of the main process
 *    entry chunk, ensuring hooks are registered before any hoisted requires.
 * 3. Copies dd-trace and @datadog/electron-sdk into the build output's
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
  renderChunk?: (code: string, chunk: { isEntry: boolean }) => string | null;
  generateBundle?: () => void;
  writeBundle?: (options: { dir?: string }) => void;
}

interface PluginContext {
  emitFile: (file: { type: string; fileName: string; source: string | Uint8Array }) => void;
}

const BANNER = [
  'try {',
  '  require("node:module").createRequire(__filename)("dd-trace").default.init({ experimental: { exporter: "electron" } });',
  '} catch {}',
].join(' ');

// dd-trace resolves its preload at: join(__dirname, 'electron', 'preload.js')
// When bundled, __dirname is the output directory, so we emit the file there.
const DD_TRACE_PRELOAD_PATH = 'electron/preload.js';

export function datadogVitePlugin(): VitePlugin {
  let preloadSource: string | undefined;
  // Support both CJS (__filename) and ESM (import.meta.url) contexts at build time
  const currentFile = typeof __filename !== 'undefined' ? __filename : fileURLToPath(import.meta.url);
  const _require = createRequire(currentFile);

  // Resolve dd-trace's preload file at build time (node_modules is available here)
  try {
    const preloadPath = _require.resolve('dd-trace/packages/datadog-instrumentations/src/electron/preload.js');
    preloadSource = readFileSync(preloadPath, 'utf8');
  } catch {
    // dd-trace not found — skip preload copy
  }

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
    renderChunk(code, chunk) {
      if (!chunk.isEntry) return null;
      return `${BANNER}\n${code}`;
    },
    generateBundle(this: PluginContext) {
      if (preloadSource) {
        this.emitFile({
          type: 'asset',
          fileName: DD_TRACE_PRELOAD_PATH,
          source: preloadSource,
        });
      }
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
          };
          for (const dep of Object.keys(pkgJson.dependencies ?? {})) {
            copyPackageTree(dep);
          }
        } catch {
          // Package not found — skip
        }
      }

      copyPackageTree('dd-trace');
      copyPackageTree('@datadog/electron-sdk');
    },
  };
}
