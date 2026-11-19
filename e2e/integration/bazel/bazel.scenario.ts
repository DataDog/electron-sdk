import { createRequire } from 'node:module';
import { isAbsolute, join, relative, sep } from 'node:path';
import { chmod, cp, mkdtemp, readdir, realpath, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { _electron as electron, type ElectronApplication } from '@playwright/test';
import { test, expect } from '../lib/integrationFixture';
import { registerAppPath } from '../../lib/intake';
import { assertExpectedElectronVersion } from '../../lib/compatibility';

test('staged Bazel output sends renderer errors and traced main-process resources outside the checkout', async ({
  intake,
  testServer,
}, testInfo) => {
  const workflow = testInfo.project.metadata.workflow as string;
  const source = join(__dirname, '../generated/bazel-vite/bazel-bin', `${workflow}_app`);
  const isolated = await mkdtemp(join(tmpdir(), 'electron-sdk-bazel-'));
  let app: ElectronApplication | undefined;
  try {
    await cp(source, isolated, { recursive: true, verbatimSymlinks: true });
    // Bazel outputs are read-only; the disposable copy needs writable directories for cleanup.
    await chmod(isolated, 0o700);
    const isolatedRoot = await realpath(isolated);
    // No dependency link may escape into the checkout, pnpm store, or Bazel cache.
    for (const entry of await readdir(isolated, { recursive: true, withFileTypes: true })) {
      if (entry.isDirectory()) await chmod(join(entry.parentPath, entry.name), 0o700);
      if (!entry.isSymbolicLink()) continue;
      const target = await realpath(join(entry.parentPath, entry.name));
      const relativeTarget = relative(isolatedRoot, target);
      expect(isAbsolute(relativeTarget)).toBe(false);
      expect(relativeTarget.split(sep)).not.toContain('..');
    }
    const request = createRequire(join(isolated, 'dist/main.js'));
    expect(existsSync(join(isolated, 'node_modules'))).toBe(workflow === 'default-copy');
    expect(existsSync(join(isolated, 'dist/node_modules'))).toBe(workflow === 'plugin-copy');
    const sdk = createRequire(request.resolve('@datadog/electron-sdk'));
    const tracer = createRequire(sdk.resolve('dd-trace-electron'));
    const hook = createRequire(tracer.resolve('import-in-the-middle'));
    for (const name of ['cjs-module-lexer', 'es-module-lexer']) {
      expect(hook.resolve(name).startsWith(isolatedRoot + sep)).toBe(true);
    }
    app = await electron.launch({
      executablePath: createRequire(__filename)('electron') as string,
      args: [join(isolated, 'dist/main.js'), `--user-data-dir=${join(isolated, 'user-data')}`],
      env: {
        ...process.env,
        DD_SDK_CONFIG: JSON.stringify({
          site: 'datadoghq.com',
          proxy: `http://localhost:${intake.getPort()}/api/v2/rum`,
          clientToken: 'integration-test-token',
          applicationId: 'integration-test-app-id',
          service: 'bazel-integration-test',
          env: 'test',
          allowedRendererHosts: ['*'],
          telemetrySampleRate: 100,
        }),
      },
    });
    await assertExpectedElectronVersion(app);
    await registerAppPath(intake, app);
    const window = await app.firstWindow();
    await window.waitForLoadState('load');
    await window.waitForFunction(() => Boolean((globalThis as any).__integrationTest));
    await window.evaluate(async (url) => {
      (globalThis as any).__integrationTest.triggerRendererError('Bazel staged renderer error');
      await (globalThis as any).electronAPI.mainFetch(url);
    }, testServer.urlFor(200));
    await expect
      .poll(
        async () => {
          await window.evaluate(async () => {
            await (globalThis as any).electronAPI.flushTransport();
          });
          return (await intake.getEventsByType('error')).some(
            ({ body }) => body.error.message === 'Bazel staged renderer error'
          );
        },
        { timeout: 30_000 }
      )
      .toBe(true);
    const resources = await intake.waitForEventCount('resource', 1);
    expect(resources[0].body.resource.url).toBe(testServer.urlFor(200));
    expect(resources[0].body).toHaveProperty('_dd.trace_id');
    const traceId = resources[0].body._dd.trace_id!;
    const span = await intake.waitForSpan((span) => BigInt(`0x${span.trace_id}`) === BigInt(traceId));
    expect(span.meta['_dd.session.id']).toBe(resources[0].body.session.id);
  } finally {
    try {
      await app?.close();
    } finally {
      await rm(isolated, { recursive: true, force: true });
    }
  }
});
