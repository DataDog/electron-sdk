/**
 * Webpack plugin for Electron apps using the Datadog Electron SDK.
 *
 * This plugin handles four concerns for packaged Electron apps:
 *
 * 1. Prepends dd-trace initialization (via @datadog/electron-sdk/instrument)
 *    as a banner to the main entry, so the user doesn't need to manually
 *    import '@datadog/electron-sdk/instrument'.
 *
 * 2. Externalizes dd-trace and @datadog/electron-sdk so they remain as runtime
 *    requires (not bundled), avoiding issues with dd-trace's dynamic requires,
 *    native modules, and optional peer dependencies.
 *
 * 3. Excludes dd-trace and @datadog/electron-sdk from @vercel/webpack-asset-
 *    relocator-loader, which would otherwise break dd-trace's internal module
 *    resolution (createRequire, dynamic _require.resolve).
 *
 * 4. Copies dd-trace, @datadog/electron-sdk, and their transitive dependencies
 *    into the webpack output's node_modules so they are available at runtime
 *    in packaged apps where the project's node_modules is absent. The SDK
 *    writes its own preload script at runtime — no manual copy needed.
 *
 * Usage:
 *   const { DatadogWebpackPlugin } = require('@datadog/electron-sdk/webpack-plugin');
 *
 *   module.exports = {
 *     plugins: [new DatadogWebpackPlugin()],
 *   };
 */

import { join, dirname } from 'node:path';
import { mkdirSync, existsSync, readFileSync, cpSync } from 'node:fs';
import { createRequire } from 'node:module';

interface Rule {
  test?: RegExp;
  exclude?: RegExp;
  use?: string | { loader?: string } | (string | { loader?: string })[];
}

type BannerPluginConstructor = new (options: { banner: string; raw: boolean; entryOnly: boolean }) => {
  apply: (compiler: Compiler) => void;
};

interface Compiler {
  options: {
    externals?: unknown;
    module: {
      rules: (Rule | { oneOf?: Rule[] })[];
    };
  };
  webpack: {
    BannerPlugin: BannerPluginConstructor;
  };
  hooks: {
    afterEmit: {
      tap: (name: string, cb: (compilation: { outputOptions: { path: string } }) => void) => void;
    };
  };
}

// Support both CJS (__filename) and ESM (import.meta.url) contexts
const _require = typeof __filename !== 'undefined' ? require : createRequire(import.meta.url);

const EXCLUDE_PATTERN = /[/\\]node_modules[/\\](dd-trace|@datadog[/\\]electron-sdk)[/\\]/;
const ASSET_RELOCATOR = '@vercel/webpack-asset-relocator-loader';

function usesAssetRelocator(rule: Rule): boolean {
  const use = rule.use;
  if (!use) return false;
  if (typeof use === 'string') return use.includes(ASSET_RELOCATOR);
  if (!Array.isArray(use)) return typeof use.loader === 'string' && use.loader.includes(ASSET_RELOCATOR);
  return use.some((u) => (typeof u === 'string' ? u.includes(ASSET_RELOCATOR) : u.loader?.includes(ASSET_RELOCATOR)));
}

function addExcludeToRule(rule: Rule): void {
  if (!rule.exclude) {
    rule.exclude = EXCLUDE_PATTERN;
  } else if (rule.exclude instanceof RegExp) {
    rule.exclude = new RegExp(`(?:${rule.exclude.source})|(?:${EXCLUDE_PATTERN.source})`);
  }
}

function copyPackageTree(pkg: string, destModules: string, visited: Set<string>): void {
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
      copyPackageTree(dep, destModules, visited);
    }
  } catch {
    console.warn(`[datadog] Failed to copy package '${pkg}' to build output`);
  }
}

export class DatadogWebpackPlugin {
  apply(compiler: Compiler): void {
    // Externalize dd-trace and @datadog/electron-sdk so webpack doesn't bundle them
    const ddTraceExternals = [/^dd-trace(\/.*)?$/, /^@datadog\/electron-sdk(\/.*)?$/];
    const existing = compiler.options.externals;
    if (!existing) {
      compiler.options.externals = ddTraceExternals;
    } else if (Array.isArray(existing)) {
      (existing as unknown[]).push(...ddTraceExternals);
    } else {
      compiler.options.externals = [existing as RegExp, ...ddTraceExternals];
    }

    // Prepend dd-trace initialization banner so the user doesn't need to
    // manually import '@datadog/electron-sdk/instrument'
    new compiler.webpack.BannerPlugin({
      banner: 'try{require("@datadog/electron-sdk/instrument")}catch{}',
      raw: true,
      entryOnly: true,
    }).apply(compiler);

    // Exclude dd-trace and @datadog/electron-sdk from the asset-relocator-loader
    for (const rule of compiler.options.module.rules) {
      if ('oneOf' in rule && rule.oneOf) {
        for (const oneOfRule of rule.oneOf) {
          if (usesAssetRelocator(oneOfRule)) addExcludeToRule(oneOfRule);
        }
      } else if (usesAssetRelocator(rule as Rule)) {
        addExcludeToRule(rule as Rule);
      }
    }

    // Copy externalized packages and node_modules into the output
    compiler.hooks.afterEmit.tap('DatadogWebpackPlugin', (compilation) => {
      const outputPath = compilation.outputOptions.path;

      // Copy externalized packages into node_modules alongside the bundle
      // so they are available at runtime in packaged apps
      const destModules = join(outputPath, 'node_modules');
      const visited = new Set<string>();
      copyPackageTree('dd-trace', destModules, visited);
      copyPackageTree('@datadog/electron-sdk', destModules, visited);
    });
  }
}
