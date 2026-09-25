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
    'src/domain/logs/index.ts',
    'rum-events-format/lib/generated/rum.ts',
    '.git/refs/heads/out',
    'local-edit.ts',
    'src/fixtures/新建文件夹/café.ts',
    '.git/objects/ab/readonly-object',
  ];
  const artifacts = [
    'node_modules/electron/index.js',
    'e2e/app/node_modules/electron/index.js',
    'e2e/app/dist/main.js',
    'e2e/compatibility/generated/electron-41/metadata.json',
    'windows-test-artifacts/previous/container.log',
    '.npm-cache/file',
    'e2e/integration/integration-sdk.tgz',
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
