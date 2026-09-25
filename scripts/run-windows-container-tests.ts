/** Entry point inside the Windows test image. Use ci/windows/run.ps1 on the host. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { command } from './lib/command.ts';
import { runMain } from './lib/executionUtils.ts';
import { runLoggedCommand } from './lib/loggedCommand.ts';
import { copyWindowsContainerWorkspace } from './lib/windowsContainer.ts';

runMain(async () => {
  if (process.platform !== 'win32') throw new Error('This entry point runs inside the Windows test container.');
  const suite = process.env.DD_ELECTRON_TEST_SUITE ?? 'compatibility';
  if (!['compatibility', 'e2e', 'integration'].includes(suite)) throw new Error(`Unknown suite: ${suite}`);
  const target = process.env.DD_ELECTRON_COMPATIBILITY_TARGET ?? 'electron-41';
  const source = 'C:\\source';
  const workspace = 'C:\\w';
  const artifacts = 'C:\\artifacts';

  console.log(`Copying test sources from ${source} to ${workspace}...`);
  copyWindowsContainerWorkspace(source, workspace);
  console.log('Test sources copied. Checking Node and Yarn versions...');
  process.chdir(workspace);
  const manifest = JSON.parse(fs.readFileSync('package.json', 'utf8')) as { volta: { node: string; yarn: string } };
  if (process.versions.node !== manifest.volta.node || command`yarn --version`.run().trim() !== manifest.volta.yarn) {
    throw new Error('The Windows image toolchain no longer matches package.json. Update ci/windows/install-tools.ps1.');
  }
  console.log('Toolchain versions match package.json. Recording the test environment...');
  fs.writeFileSync(
    path.join(artifacts, 'environment.json'),
    JSON.stringify(
      {
        platform: process.platform,
        architecture: process.arch,
        osRelease: os.release(),
        node: process.version,
        suite,
        target,
        commit: command`git rev-parse HEAD`.run().trim(),
      },
      null,
      2
    )
  );
  const targetArguments = suite === 'compatibility' ? [target] : [];
  try {
    await runLoggedCommand({
      command: 'yarn',
      args: ['install', '--immutable'],
      environment: { ELECTRON_SKIP_BINARY_DOWNLOAD: '1' },
      logFile: path.join(artifacts, '01-yarn-install.log'),
      retryDelays: [2_000, 5_000],
    });
    await runLoggedCommand({
      command: 'yarn',
      args: [`test:${suite}:init`, ...targetArguments],
      environment: {},
      logFile: path.join(artifacts, '02-init.log'),
      retryDelays: [],
    });
    await runLoggedCommand({
      command: 'yarn',
      args: [`test:${suite}`, ...targetArguments],
      environment: {},
      logFile: path.join(artifacts, '03-tests.log'),
      retryDelays: [],
    });
  } finally {
    for (const relative of [
      'test-results',
      'playwright-report',
      `e2e/compatibility/generated/${target}/metadata.json`,
    ]) {
      if (fs.existsSync(relative)) {
        const destination = path.join(artifacts, relative);
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.cpSync(relative, destination, { recursive: true });
      }
    }
  }
});
