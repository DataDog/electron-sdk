/** Generates the scheduled compatibility child pipeline from its canonical JSON config. */
import fs from 'node:fs';
import path from 'node:path';

import { getRepositoryRoot, loadCompatibilityConfig } from './lib/compatibility.ts';
import { generateCompatibilityCi } from './lib/compatibilityCi.ts';
import { printLog, runMain } from './lib/executionUtils.ts';

runMain(() => {
  const output = path.join(getRepositoryRoot(), 'e2e/compatibility/generated.gitlab-ci.yml');
  fs.writeFileSync(output, generateCompatibilityCi(loadCompatibilityConfig()));
  printLog(`Generated compatibility child pipeline at ${output}`);
});
