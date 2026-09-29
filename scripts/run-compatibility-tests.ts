import fs from 'node:fs';
import { command } from './lib/command.ts';
import { runMain } from './lib/executionUtils.ts';
import { getCompatibilityTarget, getGeneratedTargetRoot, loadCompatibilityConfig } from './lib/compatibility.ts';

runMain(() => {
  // The target comes first; remaining arguments are forwarded to Playwright.
  // Example: yarn test:compatibility electron-41 --project=forge-vite-packaged --grep 'view event'
  const [id, ...args] = process.argv.slice(2);
  getCompatibilityTarget(loadCompatibilityConfig(), id);
  const root = getGeneratedTargetRoot(id);
  if (!fs.existsSync(`${root}/metadata.json`)) throw new Error(`Run yarn test:compatibility:init ${id} first.`);
  command`yarn playwright test -c e2e ${args}`
    .withEnvironment({
      DD_ELECTRON_COMPATIBILITY_TARGET: id,
    })
    .withLogs()
    .run();
});
