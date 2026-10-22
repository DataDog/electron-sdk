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
const packageOutputDirectories = ['dist', 'out', '.vite', '.webpack'];

runMain(() => {
  const apps = fs
    .readdirSync(appsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

  for (const app of apps) {
    const appDir = path.join(appsDir, app);
    const generatedFiles = ['yarn.lock', '.yarnrc.yml']
      .filter((fileName) => fs.existsSync(path.join(appDir, fileName)))
      .map((fileName) => {
        const filePath = path.join(appDir, fileName);
        return { filePath, contents: fs.readFileSync(filePath) };
      });

    try {
      printLog(`\n=== Installing ${app} ===`);
      // Use --no-immutable because the integration-sdk.tgz is built fresh on every CI run,
      // so its hash changes and the committed yarn.lock needs to be updated.
      command`yarn install --no-immutable`.withCurrentWorkingDirectory(appDir).withLogs().run();

      printLog(`\n=== Packaging ${app} ===`);
      for (const outputDirectory of packageOutputDirectories) {
        fs.rmSync(path.join(appDir, outputDirectory), { recursive: true, force: true });
      }
      command`yarn package`.withCurrentWorkingDirectory(appDir).withLogs().run();
    } finally {
      // Yarn may update the tarball checksum, lockfile metadata, and compatibility settings
      // while installing. Preserve the developer's original files after packaging.
      for (const { filePath, contents } of generatedFiles) {
        fs.writeFileSync(filePath, contents);
      }
    }
  }

  printLog('\nAll integration apps ready.');
});
