import { createRequire } from 'node:module';
import { display } from '../tools/display';

// Use _require (dynamic call) rather than a static `import from 'dd-trace'` so that the
// bundled CJS output keeps this require() call in-place instead of hoisting it to the top
// of the bundle. The env var must be set before dd-trace's register.js is loaded — if it
// loads without 'electron' in DD_TRACE_DISABLED_INSTRUMENTATIONS it registers a RITM hook
// that wraps net.request, causing duplicate spans alongside our own patchNet wrapper.
const _require = typeof __filename !== 'undefined' ? require : createRequire(import.meta.url);

const _existing = process.env['DD_TRACE_DISABLED_INSTRUMENTATIONS'];
process.env['DD_TRACE_DISABLED_INSTRUMENTATIONS'] = _existing ? `${_existing},electron` : 'electron';

type Tracer = typeof import('dd-trace').default;

/**
 * Loads dd-trace defensively. dd-trace is a bundled direct dependency, but a failure here (e.g. a
 * corrupted install) must not throw while the app evaluates `import '@datadog/electron-sdk/instrument'`
 * and crash startup — that would bypass the intended "monitoring disabled" degradation. On failure we
 * warn and return a no-op tracer, so tracing no-ops while preload/RUM (which does not use the tracer)
 * keeps working.
 */
export function loadTracer(requireFn: NodeRequire): Tracer {
  try {
    return (requireFn('dd-trace') as { default: Tracer }).default;
  } catch {
    display.warn('dd-trace not found, monitoring will not work');
    return createNoopTracer();
  }
}

function createNoopTracer(): Tracer {
  const scope = { active: () => null, activate: (_span: unknown, fn: () => unknown) => fn() };
  return {
    init: () => undefined,
    startSpan: () => undefined,
    scope: () => scope,
    inject: () => undefined,
  } as unknown as Tracer;
}

const ddTrace = loadTracer(_require);
export default ddTrace;
