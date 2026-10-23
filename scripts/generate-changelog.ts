import { runMain } from './lib/executionUtils.ts';
import { generateChangelogSection } from './lib/changelog.ts';
import { getCommitsSinceLastTag } from './lib/git.ts';

runMain(() => {
  const version = process.argv[2] ?? process.env.VERSION;
  if (!version) {
    throw new Error('Usage: node scripts/generate-changelog.ts <VERSION>  or  VERSION=x.y.z node ...');
  }

  const commits = getCommitsSinceLastTag();
  const today = new Date().toISOString().slice(0, 10);
  const section = generateChangelogSection(version, today, commits);

  process.stdout.write(section);
});
