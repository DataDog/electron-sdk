/**
 * Runs Playwright against a previously generated compatibility target.
 * Extra arguments are forwarded to Playwright.
 *
 * Usage:
 *   node scripts/run-compatibility-tests.ts electron-41
 *   node scripts/run-compatibility-tests.ts electron-41 --template forge-webpack --mode packaged
 */
import fs from 'node:fs';

import {
  getCompatibilityTarget,
  getElectronDimension,
  getGeneratedTargetRoot,
  loadCompatibilityConfig,
} from './lib/compatibility.ts';
import { command } from './lib/command.ts';
import { parseCompatibilityRunOptions, selectCompatibilityPlaywrightProjects } from './lib/compatibilityOptions.ts';
import { runMain } from './lib/executionUtils.ts';

runMain(() => {
  const options = parseCompatibilityRunOptions(process.argv.slice(2));
  const config = loadCompatibilityConfig();
  const target = getCompatibilityTarget(config, options.targetId);
  const electron = getElectronDimension(target);
  const targetRoot = getGeneratedTargetRoot(target.id);
  if (!fs.existsSync(targetRoot)) {
    throw new Error(
      `Compatibility target ${target.id} has not been generated. Run yarn test:compatibility:init ${target.id}.`
    );
  }

  const selectedProjects = selectCompatibilityPlaywrightProjects(config, options);
  const projectArguments = selectedProjects.map((project) => `--project=${project}`);
  command`yarn playwright test -c e2e ${projectArguments} ${options.playwrightArguments}`
    .withEnvironment({
      DD_ELECTRON_COMPATIBILITY_ROOT: targetRoot,
      DD_ELECTRON_COMPATIBILITY_TARGET: target.id,
      DD_ELECTRON_EXPECTED_VERSION: electron.version,
    })
    .withLogs()
    .run();
});
