const BUNDLED_MODE = '@datadog/electron-sdk:bundledMode';

// Instrumentation and init are separate SDK bundles, so the selection must be process-wide.
export function getTracerModule(): string {
  return (globalThis as Record<symbol, unknown>)[Symbol.for(BUNDLED_MODE)] === true
    ? './tracer.cjs'
    : 'dd-trace-electron';
}

export function createBundledModeBanner(bundledMode = false, format: 'cjs' | 'esm' = 'cjs'): string {
  const selection = `globalThis[Symbol.for(${JSON.stringify(BUNDLED_MODE)})]=${bundledMode === true};`;
  // An ESM dependency must set the mode before any static SDK imports evaluate.
  return format === 'esm' ? `import "data:text/javascript,${encodeURIComponent(selection)}";` : selection;
}
