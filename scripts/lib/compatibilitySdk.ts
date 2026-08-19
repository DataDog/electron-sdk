import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { command } from './command.ts';
import { getRepositoryRoot } from './compatibility.ts';
import { printLog } from './executionUtils.ts';

export type PreparedSdkSource =
  { kind: 'current-checkout' } | { kind: 'tarball'; path: string } | { kind: 'git-ref'; ref: string; commit: string };

interface PrepareSdkTarballOptions {
  providedTarball: string | null;
  sdkRef: string | null;
  destination: string;
}

export function prepareSdkTarball({
  providedTarball,
  sdkRef,
  destination,
}: PrepareSdkTarballOptions): PreparedSdkSource {
  if (providedTarball) {
    const source = path.resolve(providedTarball);
    if (!fs.existsSync(source)) throw new Error(`SDK tarball not found at ${source}.`);
    fs.copyFileSync(source, destination);
    return { kind: 'tarball', path: source };
  }

  if (sdkRef) {
    const commit = withSdkCheckoutAtRef(sdkRef, (checkout) => {
      printLog(`Installing SDK dependencies from ${sdkRef}`);
      command`git submodule update --init --recursive`.withCurrentWorkingDirectory(checkout).withLogs().run();
      command`yarn install --immutable`
        .withCurrentWorkingDirectory(checkout)
        .withEnvironment({ HUSKY: '0' })
        .withLogs()
        .run();

      printLog(`Packing the SDK from ${sdkRef}`);
      command`yarn pack --out ${destination}`.withCurrentWorkingDirectory(checkout).withLogs().run();
    });
    return { kind: 'git-ref', ref: sdkRef, commit };
  }

  printLog('Packing the SDK from the current checkout');
  command`yarn pack --out ${destination}`.withCurrentWorkingDirectory(getRepositoryRoot()).withLogs().run();
  return { kind: 'current-checkout' };
}

export function withSdkCheckoutAtRef(
  sdkRef: string,
  useCheckout: (checkout: string) => void,
  repositoryRoot = getRepositoryRoot()
): string {
  assertSafeGitRef(sdkRef);
  const commit = resolveGitRef(repositoryRoot, sdkRef);
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'electron-sdk-compatibility-'));
  const checkout = path.join(temporaryRoot, 'sdk');
  let worktreeCreated = false;

  try {
    printLog(`Creating an isolated SDK checkout for ${sdkRef} (${commit})`);
    command`git worktree add --detach ${checkout} ${commit}`
      .withCurrentWorkingDirectory(repositoryRoot)
      .withLogs()
      .run();
    worktreeCreated = true;
    useCheckout(checkout);
    return commit;
  } finally {
    if (worktreeCreated) {
      command`git worktree remove --force ${checkout}`.withCurrentWorkingDirectory(repositoryRoot).run();
    }
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

function resolveGitRef(repositoryRoot: string, sdkRef: string): string {
  try {
    return resolveCommit(repositoryRoot, sdkRef);
  } catch {
    printLog(`Fetching SDK ref ${sdkRef} from origin`);
    command`git fetch --no-tags origin ${sdkRef}`.withCurrentWorkingDirectory(repositoryRoot).withLogs().run();
    return resolveCommit(repositoryRoot, 'FETCH_HEAD');
  }
}

function resolveCommit(repositoryRoot: string, sdkRef: string): string {
  return command`git rev-parse --verify --end-of-options ${`${sdkRef}^{commit}`}`
    .withCurrentWorkingDirectory(repositoryRoot)
    .run()
    .trim();
}

export function assertSafeGitRef(sdkRef: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._/@+-]*$/.test(sdkRef)) {
    throw new Error(
      `Invalid SDK Git ref "${sdkRef}". Use a branch, tag, or commit containing letters, numbers, '.', '_', '/', '@', '+', or '-'.`
    );
  }
}
