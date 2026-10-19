/**
 * Webpack plugin for Electron apps using the Datadog Electron SDK.
 *
 * This plugin handles four concerns for packaged Electron apps:
 *
 * 1. Prepends a loader for the emitted Electron instrumentation asset to the
 *    main entry, so the user does not need to import it manually.
 *
 * 2. Externalizes dd-trace while allowing the Electron SDK to be bundled.
 *
 * 3. Excludes dd-trace from @vercel/webpack-asset-relocator-loader, which would
 *    otherwise break its internal module resolution.
 *
 * 4. Emits self-contained instrumentation and preload assets, and optionally
 *    copies dd-trace's runtime dependency tree for packagers that do not stage it.
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
import { fileURLToPath } from 'node:url';

import type { DatadogBundlerPluginOptions } from './bundler-plugin-options';
import { createInstrumentationBanner, emitSdkRuntimeAssets } from './sdk-runtime-assets';

export type { DatadogBundlerPluginOptions } from './bundler-plugin-options';

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
const currentFile = typeof __filename !== 'undefined' ? __filename : fileURLToPath(import.meta.url);
const _require = createRequire(currentFile);

const EXCLUDE_PATTERN = /[/\\]node_modules[/\\]dd-trace[/\\]/;
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
    };
    for (const dep of Object.keys(pkgJson.dependencies ?? {})) {
      copyPackageTree(dep, destModules, visited);
    }
  } catch {
    console.warn(`[datadog] Failed to copy package '${pkg}' to build output`);
  }
}

/**
 * Configures Datadog instrumentation for webpack.
 *
 * @example
 * plugins: [new DatadogWebpackPlugin({ copyRuntimeDependencies: false })]
 */
export class DatadogWebpackPlugin {
  constructor(private readonly pluginOptions: DatadogBundlerPluginOptions = {}) {}

  apply(compiler: Compiler): void {
    // Keep dd-trace external; the Electron SDK itself is bundled into the application.
    const ddTraceExternals = [/^dd-trace(\/.*)?$/];
    const existing = compiler.options.externals;
    if (!existing) {
      compiler.options.externals = ddTraceExternals;
    } else if (Array.isArray(existing)) {
      (existing as unknown[]).push(...ddTraceExternals);
    } else {
      compiler.options.externals = [existing as RegExp, ...ddTraceExternals];
    }

    // Prepend the Electron instrumentation banner so the user doesn't need to
    // manually import '@datadog/electron-sdk/instrument'
    new compiler.webpack.BannerPlugin({
      banner: createInstrumentationBanner('cjs'),
      raw: true,
      entryOnly: true,
    }).apply(compiler);

    // Exclude dd-trace from the asset-relocator-loader.
    for (const rule of compiler.options.module.rules) {
      if ('oneOf' in rule && rule.oneOf) {
        for (const oneOfRule of rule.oneOf) {
          if (usesAssetRelocator(oneOfRule)) addExcludeToRule(oneOfRule);
        }
      } else if (usesAssetRelocator(rule as Rule)) {
        addExcludeToRule(rule as Rule);
      }
    }

    compiler.hooks.afterEmit.tap('DatadogWebpackPlugin', (compilation) => {
      const outputPath = compilation.outputOptions.path;
      emitSdkRuntimeAssets(currentFile, outputPath);
      if (this.pluginOptions.copyRuntimeDependencies === false) return;

      // dd-trace remains external and needs its runtime dependency tree staged
      // when the application packager does not handle external dependencies.
      const destModules = join(outputPath, 'node_modules');
      const visited = new Set<string>();
      copyPackageTree('dd-trace', destModules, visited);
    });
  }
}
