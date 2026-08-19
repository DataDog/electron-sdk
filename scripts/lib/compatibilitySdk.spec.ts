import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { command } from './command.ts';
import { assertSafeGitRef, prepareSdkTarball, withSdkCheckoutAtRef } from './compatibilitySdk.ts';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('compatibility SDK source', () => {
  it('copies a provided SDK tarball', () => {
    const directory = createTemporaryDirectory();
    const source = path.join(directory, 'source.tgz');
    const destination = path.join(directory, 'destination.tgz');
    fs.writeFileSync(source, 'sdk package');

    expect(prepareSdkTarball({ providedTarball: source, sdkRef: null, destination })).toEqual({
      kind: 'tarball',
      path: source,
    });
    expect(fs.readFileSync(destination, 'utf8')).toBe('sdk package');
  });

  it('uses an isolated worktree for a local branch without changing the harness checkout', () => {
    const repository = createGitRepository();
    const harnessCommit = command`git rev-parse HEAD`.withCurrentWorkingDirectory(repository).run().trim();

    command`git switch -c sdk-under-test`.withCurrentWorkingDirectory(repository).run();
    fs.writeFileSync(path.join(repository, 'sdk.txt'), 'SDK branch');
    command`git add sdk.txt`.withCurrentWorkingDirectory(repository).run();
    command`git commit -m sdk`.withCurrentWorkingDirectory(repository).run();
    const sdkCommit = command`git rev-parse HEAD`.withCurrentWorkingDirectory(repository).run().trim();
    command`git switch main`.withCurrentWorkingDirectory(repository).run();

    expect(
      withSdkCheckoutAtRef(
        'sdk-under-test',
        (checkout) => {
          expect(fs.readFileSync(path.join(checkout, 'sdk.txt'), 'utf8')).toBe('SDK branch');
          fs.writeFileSync(path.join(checkout, 'generated.txt'), 'removed with worktree');
        },
        repository
      )
    ).toBe(sdkCommit);
    expect(command`git rev-parse HEAD`.withCurrentWorkingDirectory(repository).run().trim()).toBe(harnessCommit);
    expect(command`git worktree list --porcelain`.withCurrentWorkingDirectory(repository).run()).not.toContain(
      'electron-sdk-compatibility-'
    );
  });

  it('rejects values that could be interpreted as Git options or revisions', () => {
    expect(() => assertSafeGitRef('--upload-pack=command')).toThrow('Invalid SDK Git ref');
    expect(() => assertSafeGitRef('main^{tree}')).toThrow('Invalid SDK Git ref');
    expect(() => assertSafeGitRef('main branch')).toThrow('Invalid SDK Git ref');
  });
});

function createGitRepository(): string {
  const repository = createTemporaryDirectory();
  command`git init --initial-branch main`.withCurrentWorkingDirectory(repository).run();
  command`git config user.email compatibility@example.com`.withCurrentWorkingDirectory(repository).run();
  command`git config user.name Compatibility`.withCurrentWorkingDirectory(repository).run();
  command`git config commit.gpgSign false`.withCurrentWorkingDirectory(repository).run();
  const hooksDirectory = path.join(repository, 'test-hooks');
  fs.mkdirSync(hooksDirectory);
  command`git config core.hooksPath ${hooksDirectory}`.withCurrentWorkingDirectory(repository).run();
  fs.writeFileSync(path.join(repository, 'harness.txt'), 'Harness branch');
  command`git add harness.txt`.withCurrentWorkingDirectory(repository).run();
  command`git commit -m harness`.withCurrentWorkingDirectory(repository).run();
  return repository;
}

function createTemporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'compatibility-sdk-'));
  temporaryDirectories.push(directory);
  return directory;
}
