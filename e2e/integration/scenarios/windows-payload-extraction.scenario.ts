import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { expect, getIntegrationAppDirectory, test } from '../lib/integrationFixture';

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
    const viteOutput = join(appDirectory, 'dist');
    expect(existsSync(join(viteOutput, 'node_modules'))).toBe(false);

    const temporaryDirectory = await mkdtemp(join(tmpdir(), 'dd-electron-msix-'));
    const archive = join(temporaryDirectory, 'unsigned-payload.zip');
    const extractionRoot = createLongExtractionRoot(temporaryDirectory);

    try {
      runWindowsPowerShellArchiveRoundTrip(viteOutput, archive, extractionRoot);
      expect(existsSync(join(extractionRoot, 'main.js'))).toBe(true);
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });
});

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
