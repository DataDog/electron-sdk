/**
 * Installs dependencies for all integration test apps and prepares them for testing.
 *
 * For each app under e2e/integration/apps/:
 *   - Runs `yarn install`
 *   - Runs `yarn package`
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { command } from './lib/command.ts';
import { printLog, runMain } from './lib/executionUtils.ts';

const appsDir = path.join(import.meta.dirname, '../e2e/integration/apps');

runMain(() => {
  const apps = fs
    .readdirSync(appsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

  for (const app of apps) {
    const appDir = path.join(appsDir, app);

    printLog(`\n=== Installing ${app} ===`);
    // Use --no-immutable because the integration-sdk.tgz is built fresh on every CI run,
    // so its hash changes and the committed yarn.lock needs to be updated.
    command`yarn install --no-immutable`.withCurrentWorkingDirectory(appDir).withLogs().run();
    // Restore lockfile as it will always be modified with new integration-sdk.tgz
    command`git restore yarn.lock`.withCurrentWorkingDirectory(appDir).withLogs().run();

    printLog(`\n=== Packaging ${app} ===`);
    command`yarn package`.withCurrentWorkingDirectory(appDir).withLogs().run();
  }

  printLog('\nAll integration apps ready.');
});
