import fs from 'node:fs';
import { command } from './lib/command.ts';
import { runMain } from './lib/executionUtils.ts';
import { getCompatibilityTarget, getGeneratedTargetRoot, loadCompatibilityConfig } from './lib/compatibility.ts';

runMain(() => {
  const [id, ...args] = process.argv.slice(2);
  const target = getCompatibilityTarget(loadCompatibilityConfig(), id);
  const root = getGeneratedTargetRoot(id);
  if (!fs.existsSync(`${root}/metadata.json`)) throw new Error(`Run yarn test:compatibility:init ${id} first.`);
  command`yarn playwright test -c e2e ${args}`
    .withEnvironment({
      DD_ELECTRON_COMPATIBILITY_ROOT: root,
      DD_ELECTRON_COMPATIBILITY_TARGET: id,
      DD_ELECTRON_EXPECTED_VERSION: target.version,
    })
    .withLogs()
    .run();
});
