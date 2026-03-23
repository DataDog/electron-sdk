import { command } from './command.ts';

/** Returns commit subjects since the last tag, or since the first commit if no tags exist. */
export function getCommitsSinceLastTag(): string[] {
  let baseRef: string;
  try {
    baseRef = command`git describe --tags --abbrev=0`.run().trim();
  } catch {
    baseRef = command`git rev-list --max-parents=0 HEAD`.run().trim();
  }
  const log = command`git log ${baseRef}..HEAD --pretty=format:%s`.run();
  return log.trim().split('\n').filter(Boolean);
}
