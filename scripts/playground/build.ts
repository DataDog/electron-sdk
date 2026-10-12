import { printLog, runMain } from '../lib/executionUtils.ts';
import { buildPlayground, watchPlayground } from './lib/build.ts';
import { PLAYGROUND_DIR, getGitSha, resolvePlaygroundVersion } from './lib/version.ts';

/**
 * Build the playground with its version baked into the renderers.
 * Usage: [PLAYGROUND_VERSION=x] node scripts/playground/build.ts [--watch]
 */
runMain(() => {
  const version = resolvePlaygroundVersion(process.env, () => getGitSha(PLAYGROUND_DIR));
  printLog(`Playground version: ${version}`);
  if (process.argv.includes('--watch')) {
    watchPlayground(version);
  } else {
    buildPlayground(version);
  }
});
