/** Builds the current SDK and maintained app fixtures for one Electron version. */
import fs from 'node:fs';
import path from 'node:path';
import { downloadArtifact } from '@electron/get';
import { command } from './lib/command.ts';
import { printLog, runMain } from './lib/executionUtils.ts';
import { RetryingFetchDownloader } from './lib/retryingFetchDownloader.ts';
import {
  getCompatibilityTarget,
  getGeneratedTargetRoot,
  getRepositoryRoot,
  loadCompatibilityConfig,
  materializeApp,
} from './lib/compatibility.ts';

runMain(async () => {
  const [id, ...extra] = process.argv.slice(2);
  if (!id || extra.length) throw new Error('Usage: yarn test:compatibility:init <target>');
  const config = loadCompatibilityConfig();
  const target = getCompatibilityTarget(config, id);
  const root = getRepositoryRoot();
  const generated = getGeneratedTargetRoot(id);
  await fs.promises.rm(generated, { recursive: true, force: true });
  fs.mkdirSync(generated, { recursive: true });
  fs.copyFileSync(path.join(root, 'tsconfig.base.json'), path.join(generated, '../tsconfig.base.json'));
  command`yarn pack --out ${path.join(generated, 'compatibility-sdk.tgz')}`
    .withCurrentWorkingDirectory(root)
    .withLogs()
    .run();

  printLog(`Prefetching Electron ${target.version} for ${process.platform}/${process.arch}`);
  await downloadArtifact({
    version: target.version,
    artifactName: 'electron',
    platform: process.platform,
    arch: process.arch,
    downloader: new RetryingFetchDownloader(),
  });
  const apps = [
    { source: 'e2e/app', destination: 'e2e-app', variant: 'default', sdk: 'file:../compatibility-sdk.tgz' },
    ...config.apps.flatMap((app) =>
      ['default', 'packager-copy'].map((variant) => ({
        source: `e2e/integration/apps/${app}`,
        destination: `integration-apps/${app}/${variant}`,
        variant,
        sdk: 'file:../../../compatibility-sdk.tgz',
      }))
    ),
  ];
  for (const app of apps) {
    printLog(`Preparing ${app.destination}`);
    const destination = path.join(generated, app.destination);
    await materializeApp(path.join(root, app.source), destination, target, app.sdk);
    const environment = {
      DD_ELECTRON_RUNTIME_DEPENDENCY_STRATEGY: app.variant === 'packager-copy' ? 'packager-copy' : 'plugin-copy',
    };
    command`yarn install --no-immutable`
      .withCurrentWorkingDirectory(destination)
      .withEnvironment(environment)
      .withLogs()
      .run();
    const script = app.destination === 'e2e-app' ? 'build' : 'package';
    command`yarn ${script}`.withCurrentWorkingDirectory(destination).withEnvironment(environment).withLogs().run();
  }
  fs.writeFileSync(
    path.join(generated, 'metadata.json'),
    JSON.stringify(
      {
        target,
        commit: command`git rev-parse HEAD`.withCurrentWorkingDirectory(root).run().trim(),
        platform: process.platform,
        architecture: process.arch,
        node: process.version,
      },
      null,
      2
    )
  );
  printLog(`Compatibility target ready: ${generated}`);
});
