import { readFileSync, readdirSync } from 'node:fs';
import { printLog, printError, runMain } from './lib/executionUtils.ts';
import { command } from './lib/command.ts';

const pkg = JSON.parse(readFileSync('package.json', 'utf-8')) as { files: string[] };
const EXPECTED_FILES = new Set(['package.json', ...pkg.files]);

runMain(() => {
  // Check 1: every file in dist/ must be accounted for in EXPECTED_FILES
  const distFiles = readdirSync('dist').map((f) => `dist/${f}`);
  const unaccountedDistFiles = distFiles.filter((f) => !EXPECTED_FILES.has(f));
  if (unaccountedDistFiles.length > 0) {
    printError('Built but not included in package:');
    unaccountedDistFiles.forEach((f) => printError(`  + ${f}`));
  }

  // Check 2: pack output must match EXPECTED_FILES exactly
  const output = command`npm pack --dry-run --json --ignore-scripts`.run();
  const [pack] = JSON.parse(output) as [{ files: { path: string }[] }];
  const actual = new Set(pack.files.map((f) => f.path));

  const missing = [...EXPECTED_FILES].filter((f) => !actual.has(f));
  const unexpected = [...actual].filter((f) => !EXPECTED_FILES.has(f));

  if (missing.length > 0) {
    printError('Missing files from package:');
    missing.forEach((f) => printError(`  - ${f}`));
  }
  if (unexpected.length > 0) {
    printError('Unexpected files in package:');
    unexpected.forEach((f) => printError(`  + ${f}`));
  }

  if (unaccountedDistFiles.length > 0 || missing.length > 0 || unexpected.length > 0) {
    throw new Error("Update the 'files' field in package.json to fix.");
  }

  printLog(`Package content matches expectations (${actual.size} files)`);
});
