import { createRequire } from 'node:module';
import { loadTracerRuntime } from './tracer-runtime';
import { display } from '../tools/display';

// Keep loading lazy so the disabled instrumentation list is set before the tracer evaluates.
const _require = createRequire(typeof __filename !== 'undefined' ? __filename : import.meta.url);

const _existing = process.env['DD_TRACE_DISABLED_INSTRUMENTATIONS'];
process.env['DD_TRACE_DISABLED_INSTRUMENTATIONS'] = _existing ? `${_existing},electron` : 'electron';

type Tracer = typeof import('dd-trace-electron').default;

/**
 * Loads dd-trace-electron defensively. The tracer can be external or embedded, but a
 * failure here (e.g. a corrupted install) must not throw while the app evaluates
 * `import '@datadog/electron-sdk/instrument'` and crash startup — that would bypass the intended
 * "monitoring disabled" degradation. On failure we warn and return a no-op tracer, so tracing
 * no-ops while preload/RUM (which does not use the tracer) keeps working.
 */
export function loadTracer(requireFn: NodeRequire): Tracer {
  try {
    return loadTracerRuntime(requireFn);
  } catch {
    display.warn('Tracer could not be loaded, monitoring will not work');
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
