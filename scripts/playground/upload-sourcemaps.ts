import { command } from '../lib/command.ts';
import { printLog, runMain } from '../lib/executionUtils.ts';
import { buildPlayground } from './lib/build.ts';
import { UPLOAD_TARGETS, buildUploadArgs, parseUploadOptions } from './lib/sourcemaps.ts';
import { PLAYGROUND_DIR, getGitSha, resolvePlaygroundVersion } from './lib/version.ts';

/**
 * Build the playground and upload its source maps, so the uploaded maps always match the built bundles.
 * Usage: [PLAYGROUND_ENV=staging|prod] [PLAYGROUND_VERSION=x] DATADOG_API_KEY=... \
 *   node scripts/playground/upload-sourcemaps.ts [--dry-run]
 */
runMain(() => {
  const { site, dryRun, apiKey } = parseUploadOptions(process.argv.slice(2), process.env);
  const version = resolvePlaygroundVersion(process.env, () => getGitSha(PLAYGROUND_DIR));

  printLog(`Building playground version ${version}...`);
  buildPlayground(version);

  for (const target of UPLOAD_TARGETS) {
    printLog(`Uploading ${target.service} (${target.minifiedPathPrefix}) version ${version} to ${site}...`);
    command`yarn datadog-ci ${buildUploadArgs(target, version, dryRun)}`
      .withCurrentWorkingDirectory(PLAYGROUND_DIR)
      .withEnvironment({ DATADOG_API_KEY: apiKey, DATADOG_SITE: site })
      .withLogs()
      .run();
  }
});
