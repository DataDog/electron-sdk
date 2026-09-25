import fs from 'node:fs';
import path from 'node:path';

/** Copies source edits into a disposable workspace without reusing host dependencies or build outputs. */
export function copyWindowsContainerWorkspace(source: string, destination: string): void {
  const buildDirectories = new Set([
    'node_modules',
    '.yarn',
    '.vite',
    '.webpack',
    'dist',
    'out',
    'test-results',
    'playwright-report',
  ]);
  const rootArtifacts = new Set(['logs', '.npm-cache', '.test-logs', 'windows-test-artifacts', '.worktrees']);
  fs.cpSync(source, destination, {
    recursive: true,
    filter: (entry) => {
      const relative = path.relative(source, entry).split(path.sep).join('/');
      // Keep Git objects and refs intact, including names which overlap with artifact directories.
      if (relative === '.git' || relative.startsWith('.git/')) return true;
      if (rootArtifacts.has(relative.split('/')[0])) return false;
      if (relative === 'e2e/compatibility/generated' || relative === 'e2e/integration/integration-sdk.tgz')
        return false;
      return !buildDirectories.has(path.basename(entry)) && !entry.endsWith('.tsbuildinfo');
    },
  });
}
