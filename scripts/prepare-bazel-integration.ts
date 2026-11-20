/** Materializes an opt-in Bazel/rules_js fixture using the maintained Vite app and SDK tarball. */
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { command } from './lib/command.ts';
import { printLog, runMain } from './lib/executionUtils.ts';

runMain(async () => {
  const root = join(import.meta.dirname, '..');
  const integration = join(root, 'e2e/integration');
  const workspace = join(integration, 'generated/bazel-vite');
  const app = join(integration, 'apps/electron-builder-vite');
  await fs.mkdir(workspace, { recursive: true });
  command`yarn pack --out ${join(workspace, 'sdk.tgz')}`.withCurrentWorkingDirectory(root).withLogs().run();
  // The local tarball keeps its filename across builds, but its lockfile integrity must be refreshed.
  await fs.rm(join(workspace, 'pnpm-lock.yaml'), { force: true });
  for (const file of [
    '.bazelversion',
    '.npmrc',
    'MODULE.bazel',
    'BUILD.bazel',
    'pnpm-workspace.yaml',
    'build.mjs',
    'stage.mjs',
  ]) {
    await fs.copyFile(join(integration, 'bazel', file), join(workspace, file));
  }
  await fs.cp(join(app, 'src'), join(workspace, 'src'), { recursive: true });
  for (const file of ['vite.main.config.ts', 'vite.preload.config.ts', 'workflow.ts']) {
    await fs.copyFile(join(app, file), join(workspace, file));
  }
  const baseline = JSON.parse(await fs.readFile(join(app, 'package.json'), 'utf8'));
  await fs.writeFile(
    join(workspace, 'package.json'),
    JSON.stringify(
      {
        name: 'bazel-electron-sdk',
        version: '1.0.0',
        private: true,
        packageManager: 'pnpm@10.22.0',
        dependencies: {
          '@datadog/electron-sdk': 'file:./sdk.tgz',
          '@datadog/browser-rum': baseline.dependencies['@datadog/browser-rum'],
        },
        devDependencies: { vite: baseline.devDependencies.vite },
      },
      null,
      2
    ) + '\n'
  );
  printLog(`Fixture prepared in ${workspace}. See e2e/integration/bazel/README.md for build and test commands.`);
});
