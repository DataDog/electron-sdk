type Tracer = typeof import('dd-trace-electron').default;

const EMBEDDED_TRACER = Symbol.for('@datadog/electron-sdk:embeddedTracer');
const BUNDLED_MODE = '@datadog/electron-sdk:bundledMode';
const COPY_RUNTIME_DEPENDENCIES = '@datadog/electron-sdk:copyRuntimeDependencies';

// Instrumentation and init are separate SDK bundles, so the selection must be process-wide.
export function getTracerModule(): string {
  return isBundledMode() ? './tracer.cjs' : 'dd-trace-electron';
}

export function createBundledModeBanner(
  bundledMode = false,
  format: 'cjs' | 'esm' = 'cjs',
  copyRuntimeDependencies = false
): string {
  const selection = `globalThis[Symbol.for(${JSON.stringify(BUNDLED_MODE)})]=${bundledMode === true};globalThis[Symbol.for(${JSON.stringify(COPY_RUNTIME_DEPENDENCIES)})]=${bundledMode !== true && copyRuntimeDependencies === true};`;
  // An ESM dependency must set the mode before any static SDK imports evaluate.
  return format === 'esm' ? `import "data:text/javascript,${encodeURIComponent(selection)}";` : selection;
}

export function isBundledMode(): boolean {
  return (globalThis as Record<symbol, unknown>)[Symbol.for(BUNDLED_MODE)] === true;
}

/** Effective build options, shared by the instrumentation and SDK bundles. */
export function getBundlerConfiguration(): { bundledMode: boolean; copyRuntimeDependencies: boolean } {
  const bundledMode = isBundledMode();
  return {
    bundledMode,
    copyRuntimeDependencies:
      !bundledMode && (globalThis as Record<symbol, unknown>)[Symbol.for(COPY_RUNTIME_DEPENDENCIES)] === true,
  };
}

// The emitted instrumentation loads the tracer beside itself. The SDK bundled into the app
// reuses that instance instead of resolving a tracer asset relative to the application's entry.
export function loadTracerRuntime(requireFn: NodeRequire): Tracer {
  const runtime = globalThis as Record<symbol, unknown>;
  if (isBundledMode() && runtime[EMBEDDED_TRACER] !== undefined) return runtime[EMBEDDED_TRACER] as Tracer;
  const tracer = (requireFn(getTracerModule()) as { default: Tracer }).default;
  if (isBundledMode()) runtime[EMBEDDED_TRACER] = tracer;
  return tracer;
}
