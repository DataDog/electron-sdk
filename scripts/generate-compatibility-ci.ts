/** Generates the compatibility child pipeline from Electron targets and CI environment definitions. */
import fs from 'node:fs';
import path from 'node:path';

import { getRepositoryRoot, loadCompatibilityConfig } from './lib/compatibility.ts';
import { generateCompatibilityCi, parseCompatibilityCiFilters } from './lib/compatibilityCi.ts';
import { printLog, runMain } from './lib/executionUtils.ts';

runMain(() => {
  const config = loadCompatibilityConfig();
  const filters = parseCompatibilityCiFilters(config);
  const output = path.join(getRepositoryRoot(), 'e2e/compatibility/generated.gitlab-ci.yml');
  fs.writeFileSync(output, generateCompatibilityCi(config, filters));
  printLog(`Generated compatibility child pipeline at ${output}`);
});
