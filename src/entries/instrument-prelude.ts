import { createRequire } from 'node:module';

// Use _require (dynamic call) rather than a static `import from 'dd-trace'` so that the
// bundled CJS output keeps this require() call in-place instead of hoisting it to the top
// of the bundle. The env var must be set before dd-trace's register.js is loaded — if it
// loads without 'electron' in DD_TRACE_DISABLED_INSTRUMENTATIONS it registers a RITM hook
// that wraps net.request, causing duplicate spans alongside our own patchNet wrapper.
const _require = typeof __filename !== 'undefined' ? require : createRequire(import.meta.url);

const _existing = process.env['DD_TRACE_DISABLED_INSTRUMENTATIONS'];
process.env['DD_TRACE_DISABLED_INSTRUMENTATIONS'] = _existing ? `${_existing},electron` : 'electron';

const ddTrace = (_require('dd-trace') as { default: typeof import('dd-trace').default }).default;
export default ddTrace;
