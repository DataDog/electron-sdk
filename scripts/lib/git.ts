import { command } from './command.ts';

const RELEASE_COMMIT_LOG_RE = /^[0-9a-f]+ v?\d+\.\d+\.\d+( \(#\d+\))?$/;

/** Returns commit subjects since the last release commit, or since the first commit if none exists.
 * Uses log scanning instead of `git describe` because release tags are created on the release
 * branch and are not ancestors of main. */
export function getCommitsSinceLastTag(): string[] {
  const format = 'format:%H %s';
  const fullLog = command`git log HEAD --pretty=${format}`.run();
  const lines = fullLog.trim().split('\n').filter(Boolean);
  const releaseLine = lines.find((l) => RELEASE_COMMIT_LOG_RE.test(l));
  if (!releaseLine) {
    // No release commit found — return all commits
    const log = command`git log HEAD --pretty=format:%s`.run();
    return log.trim().split('\n').filter(Boolean);
  }
  const hash = releaseLine.split(' ')[0];
  const log = command`git log ${hash}..HEAD --pretty=format:%s`.run();
  return log.trim().split('\n').filter(Boolean);
}
