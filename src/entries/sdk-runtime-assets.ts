import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { createBundledModeBanner } from './tracer-runtime';

const SDK_RUNTIME_DIRECTORY = '.datadog';
const RUNTIME_FILES = ['instrument.cjs', 'preload.js', 'tracer.cjs', 'tracer.LICENSE'];

/** Loads instrumentation from the emitted assets before the application entry point. */
export function createInstrumentationBanner(format: 'cjs' | 'esm', entryFileName = 'entry.js'): string {
  const instrumentPath = posix.relative(
    posix.dirname(entryFileName.replace(/\\/g, '/')),
    posix.join(SDK_RUNTIME_DIRECTORY, 'instrument.cjs')
  );
  const request =
    instrumentPath.startsWith('./') || instrumentPath.startsWith('../') ? instrumentPath : `./${instrumentPath}`;
  const mode = createBundledModeBanner(true, format);
  if (format === 'esm') {
    return `${mode}\nimport { createRequire as __ddCR } from "node:module";\ntry { __ddCR(import.meta.url)(${JSON.stringify(request)}); } catch {}`;
  }
  return `${mode}\ntry { require("node:module").createRequire(__filename)(${JSON.stringify(request)}); } catch {}`;
}

/** Emits runtime assets without copying the SDK or tracer package trees. */
export function emitSdkRuntimeAssets(pluginFile: string, outDir: string): void {
  const runtimeDirectory = join(outDir, SDK_RUNTIME_DIRECTORY);
  mkdirSync(runtimeDirectory, { recursive: true });
  for (const file of RUNTIME_FILES) {
    copyFileSync(join(dirname(pluginFile), file), join(runtimeDirectory, file));
  }
}
