import { existsSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { spawnSync } from 'node:child_process';

import { expect, findDevMainScript, getIntegrationAppDirectory, test } from '../lib/integrationFixture';

const LEGACY_WINDOWS_MAX_PATH = 260;
const EXTRACTION_ROOT_MINIMUM_LENGTH = 180;

test.describe('Windows unsigned payload extraction @integration @windows', () => {
  test.skip(process.platform !== 'win32', 'Windows PowerShell 5.1 regression coverage');

  test('extracts the packager-owned Vite output below the legacy path limit', async ({ app, mode, variant }) => {
    test.skip(
      app !== 'electron-builder-vite' || mode !== 'packaged' || variant !== 'packager-copy',
      'electron-builder-vite packager-copy packaged only'
    );

    const appDirectory = getIntegrationAppDirectory(app, variant);
    const viteOutput = dirname(findDevMainScript(appDirectory, variant));
    expect(existsSync(join(viteOutput, 'node_modules'))).toBe(false);

    const temporaryDirectory = await mkdtemp(join(tmpdir(), 'dd-electron-msix-'));
    const archive = join(temporaryDirectory, 'unsigned-payload.zip');
    try {
      const extractionRoot = createLongExtractionRoot(temporaryDirectory);

      // The default plugin copy must reproduce the PR's loose dd-trace path-length hazard.
      const defaultAppDirectory = getIntegrationAppDirectory(app, null);
      const defaultOutput = dirname(findDevMainScript(defaultAppDirectory, null));
      const defaultFiles = await listPayloadFiles(defaultOutput);
      const overlongDependencies = defaultFiles.filter(
        (file) =>
          file.startsWith(join('node_modules', 'dd-trace') + sep) &&
          join(extractionRoot, file).length >= LEGACY_WINDOWS_MAX_PATH
      );
      expect(overlongDependencies.length, 'Default copy must exceed MAX_PATH at this extraction root').toBeGreaterThan(
        0
      );

      // With copying disabled, every loose payload file fits under the same destination.
      const payloadFiles = await listPayloadFiles(viteOutput);
      expect(payloadFiles).toContain('main.js');
      expect(payloadFiles.filter((file) => join(extractionRoot, file).length >= LEGACY_WINDOWS_MAX_PATH)).toEqual([]);
      runWindowsPowerShellArchiveRoundTrip(viteOutput, archive, extractionRoot);
      expect(await listPayloadFiles(extractionRoot)).toEqual(payloadFiles);
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });
});

async function listPayloadFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => relative(directory, join(entry.parentPath, entry.name)))
    .sort();
}

function createLongExtractionRoot(temporaryDirectory: string): string {
  let extractionRoot = join(temporaryDirectory, 'unsigned-payload');
  while (extractionRoot.length < EXTRACTION_ROOT_MINIMUM_LENGTH) {
    extractionRoot = join(extractionRoot, 'temporary-extraction');
  }
  if (extractionRoot.length >= LEGACY_WINDOWS_MAX_PATH - 40) {
    throw new Error(`Windows extraction root is unexpectedly long before expanding the payload: ${extractionRoot}`);
  }
  return extractionRoot;
}

function runWindowsPowerShellArchiveRoundTrip(source: string, archive: string, destination: string): void {
  const script = join(__dirname, '../scripts/windows-payload-archive-round-trip.ps1');
  const result = spawnSync(
    'powershell.exe',
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      script,
      '-Source',
      source,
      '-Archive',
      archive,
      '-Destination',
      destination,
    ],
    { encoding: 'utf8' }
  );

  if (result.status !== 0) {
    throw new Error(
      `Windows PowerShell payload extraction failed with status ${String(result.status)}.\n` +
        `stdout:\n${result.stdout}\n` +
        `stderr:\n${result.stderr}\n` +
        `spawn error: ${result.error?.message ?? 'none'}`
    );
  }
}
