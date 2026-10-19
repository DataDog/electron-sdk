import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

const SDK_RUNTIME_DIRECTORY = '.datadog';
const INSTRUMENT_FILE = 'instrument.cjs';
const PRELOAD_FILE = 'preload.js';

/**
 * Creates a banner that loads the emitted SDK instrumentation before the application entry point.
 */
export function createInstrumentationBanner(format: 'cjs' | 'esm', entryFileName = 'entry.js'): string {
  const instrumentPath = relative(dirname(entryFileName), join(SDK_RUNTIME_DIRECTORY, INSTRUMENT_FILE)).replace(
    /\\/g,
    '/'
  );
  const request =
    instrumentPath.startsWith('./') || instrumentPath.startsWith('../') ? instrumentPath : `./${instrumentPath}`;

  if (format === 'esm') {
    return `import { createRequire as __ddCR } from "node:module";\ntry { __ddCR(import.meta.url)(${JSON.stringify(request)}); } catch {}`;
  }

  return `try { require("node:module").createRequire(__filename)(${JSON.stringify(request)}); } catch {}`;
}

/**
 * Emits the self-contained instrumentation and renderer preload next to the application bundle.
 */
export function emitSdkRuntimeAssets(pluginFile: string, outDir: string): void {
  const pluginDirectory = dirname(pluginFile);
  const runtimeDirectory = join(outDir, SDK_RUNTIME_DIRECTORY);
  mkdirSync(runtimeDirectory, { recursive: true });
  copyFileSync(join(pluginDirectory, INSTRUMENT_FILE), join(runtimeDirectory, INSTRUMENT_FILE));
  copyFileSync(join(pluginDirectory, PRELOAD_FILE), join(runtimeDirectory, PRELOAD_FILE));
}
