import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { copyWindowsContainerWorkspace } from './windowsContainer.ts';

it('copies local sources and Git refs without importing host installs or generated applications', async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'windows-container-'));
  const source = path.join(temporary, 'source');
  const destination = path.join(temporary, 'workspace');
  const sources = [
    'src/domain/logs/index.ts', // Keep nested source directories named logs; only root logs are excluded.
    'rum-events-format/lib/generated/rum.ts', // Keep generated schema sources outside compatibility fixtures.
    '.git/refs/heads/out', // Preserve Git refs even when their names match excluded build directories.
    'local-edit.ts', // Copy local files without requiring them to be tracked or committed.
    'src/fixtures/ficheiros/café.ts', // Preserve paths containing non-ASCII characters.
    '.git/objects/ab/readonly-object', // Copy read-only Git objects (permissions are set below).
  ];
  const artifacts = [
    'node_modules/electron/index.js', // Exclude root dependencies installed on the host.
    'e2e/app/node_modules/electron/index.js', // Exclude dependencies nested inside fixture apps too.
    'e2e/app/dist/main.js', // Exclude compiled app output so the container builds it afresh.
    'e2e/compatibility/generated/electron-41/metadata.json', // Exclude previously prepared compatibility fixtures.
    'windows-test-artifacts/previous/container.log', // Exclude artifacts from previous Windows runs.
    '.npm-cache/file', // Exclude the host's npm cache.
    'e2e/integration/integration-sdk.tgz', // Exclude previously packed SDK archives.
  ];
  try {
    for (const relative of [...sources, ...artifacts]) {
      const file = path.join(source, relative);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, relative);
    }
    const gitObject = path.join(source, '.git/objects/ab/readonly-object');
    fs.chmodSync(gitObject, 0o444);
    await copyWindowsContainerWorkspace(source, destination);
    for (const relative of sources) expect(fs.readFileSync(path.join(destination, relative), 'utf8')).toBe(relative);
    for (const relative of artifacts) expect(fs.existsSync(path.join(destination, relative))).toBe(false);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
