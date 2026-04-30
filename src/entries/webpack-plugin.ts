/**
 * Webpack plugin for Electron apps using the Datadog Electron SDK.
 *
 * This plugin handles two concerns for packaged Electron apps:
 *
 * 1. Copies dd-trace's preload script into the webpack output at the fallback
 *    path dd-trace expects (`electron/preload.js` relative to __dirname), so
 *    preload injection works in packaged apps where node_modules is absent.
 *
 * 2. Excludes dd-trace and @datadog/electron-sdk from @vercel/webpack-asset-
 *    relocator-loader, which would otherwise break dd-trace's internal module
 *    resolution (createRequire, dynamic require.resolve).
 *
 * Usage:
 *   const { DatadogWebpackPlugin } = require('@datadog/electron-sdk/webpack-plugin');
 *
 *   module.exports = {
 *     plugins: [new DatadogWebpackPlugin()],
 *   };
 */

import { resolve, join } from 'node:path';
import { mkdirSync, copyFileSync } from 'node:fs';

interface Rule {
  test?: RegExp;
  exclude?: RegExp;
  use?: string | { loader?: string } | (string | { loader?: string })[];
}

interface Compiler {
  options: {
    module: {
      rules: (Rule | { oneOf?: Rule[] })[];
    };
  };
  hooks: {
    afterEmit: {
      tap: (name: string, cb: (compilation: { outputOptions: { path: string } }) => void) => void;
    };
  };
}

const DD_TRACE_PRELOAD_SOURCE = 'dd-trace/packages/datadog-instrumentations/src/electron/preload.js';
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

export class DatadogWebpackPlugin {
  apply(compiler: Compiler): void {
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

    // Copy dd-trace's preload script into the output
    compiler.hooks.afterEmit.tap('DatadogWebpackPlugin', (compilation) => {
      try {
        const src = resolve(require.resolve(DD_TRACE_PRELOAD_SOURCE));
        const destDir = join(compilation.outputOptions.path, 'electron');
        mkdirSync(destDir, { recursive: true });
        copyFileSync(src, join(destDir, 'preload.js'));
      } catch {
        // dd-trace not found — skip
      }
    });
  }
}
