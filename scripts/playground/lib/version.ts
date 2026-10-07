import path from 'node:path';
import { command } from '../../lib/command.ts';

export const PLAYGROUND_DIR = path.resolve(import.meta.dirname, '../../../playground');

export function resolvePlaygroundVersion(env: NodeJS.ProcessEnv, getGitSha: () => string | undefined): string {
  const fromEnv = env.PLAYGROUND_VERSION?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  // A build must never fail on git state (CI images, tarballs), so fall back to a fixed version.
  return getGitSha() ?? 'dev';
}

export function getGitSha(cwd: string): string | undefined {
  try {
    return command`git rev-parse HEAD`.withCurrentWorkingDirectory(cwd).run().trim() || undefined;
  } catch {
    return undefined;
  }
}
