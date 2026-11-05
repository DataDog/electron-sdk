import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';

const probeScript = String.raw`
const load = createRequire(PROBE_FILENAME);
const assert = load('node:assert/strict');
process.env.DD_TRACE_DISABLED_INSTRUMENTATIONS = 'electron';
process.env.DD_INSTRUMENTATION_TELEMETRY_ENABLED = 'false';
const tracer = load('./tracer.cjs').default;
assert.equal(tracer, global._ddtrace);
const names = [];
load('node:diagnostics_channel').channel('datadog:apm:electron:export').subscribe(traces => {
for (const trace of traces) for (const span of trace) names.push(span.name);
});
tracer.init({ experimental: { exporter: 'electron' }, flushInterval: 0, startupLogs: false });
assert.equal(tracer._tracingInitialized, true);
tracer.use('fs', { enabled: true });
tracer.trace('parent', () => load('node:fs').readFileSync(PROBE_TRACER_PATH));
load('node:child_process').execFileSync(process.execPath, ['-e', '0']);
const request = load('node:http').get('http://127.0.0.1:1');
request.on('error', () => {
tracer._tracer._exporter.flush(() => {
for (const name of ['fs.operation', 'command_execution', 'http.request']) assert.ok(names.includes(name), name);
process.exit(0);
});
});
request.setTimeout(1000, () => request.destroy());
`;

it('embeds a shared tracer with built-in instrumentation and no installed runtime dependencies', () => {
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      String.raw`
    import assert from 'node:assert/strict';
    import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
    import { tmpdir } from 'node:os';
    import { join } from 'node:path';
    import { spawnSync } from 'node:child_process';
    import { rollup } from 'rollup';
    import configs from './rollup.config.mjs';
    import pkg from './package.json' with { type: 'json' };
    assert.ok(pkg.files.includes('dist/tracer.cjs'));
    assert.ok(pkg.dependencies['dd-trace-electron']);
    const config = configs.find(config => config.output.file === 'dist/tracer.cjs');
    const { output, ...input } = config;
    const bundle = await rollup(input);
    const directory = mkdtempSync(join(tmpdir(), 'dd-tracer-bundle-'));
    try {
      const generated = await bundle.generate(output);
      writeFileSync(join(directory, 'tracer.cjs'), generated.output[0].code);
      for (const extension of ['cjs', 'mjs']) {
        const script = extension === 'cjs' ? "const { createRequire } = require('node:module');" :
          "import { createRequire } from 'node:module';";
        const probe = ${JSON.stringify(probeScript)};
        writeFileSync(join(directory, 'probe.' + extension), script + probe
          .replace('PROBE_FILENAME', extension === 'cjs' ? '__filename' : 'import.meta.url')
          .replace('PROBE_TRACER_PATH', JSON.stringify(join(directory, 'tracer.cjs'))));
        const child = spawnSync(process.execPath, [join(directory, 'probe.' + extension)], {
          cwd: directory, encoding: 'utf8', timeout: 15000,
        });
        assert.equal(child.status, 0, child.stderr);
      }
    } finally {
      await bundle.close();
      rmSync(directory, { recursive: true, force: true });
    }
  `,
    ],
    { cwd: process.cwd(), encoding: 'utf8', timeout: 60000 }
  );
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
}, 65000);
