import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { runMain, printLog } from './lib/executionUtils.ts';
import { command } from './lib/command.ts';
import { bumpVersion } from './lib/semver.ts';
import { generateChangelogSection } from './lib/changelog.ts';
import { getCommitsSinceLastTag } from './lib/git.ts';

const DRY_RUN = process.argv.includes('--dry-run');
const ROOT = path.join(import.meta.dirname, '..');
const CHANGELOG_PATH = path.join(ROOT, 'CHANGELOG.md');
const PACKAGE_JSON_PATH = path.join(ROOT, 'package.json');
const YARN_LOCK_PATH = path.join(ROOT, 'yarn.lock');

runMain(async () => {
  runPreflightChecks();

  // ── Sync with main ───────────────────────────────────────────────────────
  printLog('Syncing with main...');
  command`git checkout main`.withLogs().run();
  command`git pull origin main`.withLogs().run();

  // ── Compute new version ──────────────────────────────────────────────────
  const pkg = JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, 'utf-8'));
  const newVersion = await promptNewVersion(pkg.version);
  printLog(`\nPreparing release ${newVersion}...`);

  // ── Generate and review changelog ────────────────────────────────────────
  const commits = getCommitsSinceLastTag();
  const today = new Date().toISOString().slice(0, 10);
  const draft = generateChangelogSection(newVersion, today, commits);
  const editedSection = openEditorForReview(draft);

  if (DRY_RUN) {
    printLog('\n[DRY RUN] Would apply the following changes:');
    printLog(`  - Bump package.json version: ${pkg.version} → ${newVersion}`);
    printLog(`  - Insert new section into CHANGELOG.md`);
    printLog(`  - Create branch: release/v${newVersion}`);
    printLog(`  - Commit: v${newVersion}`);
    printLog(`  - Push branch and create annotated tag: v${newVersion}`);
    printLog(`  - Open GitHub PR`);
    return;
  }

  // ── Apply changes and create PR ───────────────────────────────────────────
  applyChanges(newVersion, editedSection);
  const prUrl = createReleaseBranchAndPR(newVersion);
  printLog(`\n✅ Release PR opened: ${prUrl}`);
  printLog('Review the changelog in the PR. If you push fixup commits, move the tag:');
  printLog(`  git tag -a -f v${newVersion} -m v${newVersion} && git push -f origin v${newVersion}`);
  printLog('Merge the PR, then trigger the publish workflow from the tag.');
});

function runPreflightChecks(): void {
  const editor = process.env.EDITOR;
  if (!editor) throw new Error('$EDITOR is not set. Set it to your preferred editor (e.g. export EDITOR=vim)');

  try {
    command`gh auth status`.run();
  } catch {
    throw new Error('gh CLI is not authenticated. Run: gh auth login');
  }

  const status = command`git status --porcelain`.run().trim();
  if (status) throw new Error(`Working tree is not clean:\n${status}`);
}

async function promptNewVersion(currentVersion: string): Promise<string> {
  const options: { label: string; version: string }[] = [
    { label: 'patch', version: bumpVersion(currentVersion, 'patch') },
    { label: 'minor', version: bumpVersion(currentVersion, 'minor') },
    { label: 'major', version: bumpVersion(currentVersion, 'major') },
  ];

  console.log(`\nCurrent version: ${currentVersion}`);
  options.forEach(({ label, version }, i) => console.log(`  ${i + 1}) ${label}  →  ${version}`));
  console.log(`  4) custom`);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let newVersion!: string;

  while (true) {
    const answer = (await rl.question('\nChoose [1-4]: ')).trim();
    if (answer === '1') {
      newVersion = options[0].version;
      break;
    }
    if (answer === '2') {
      newVersion = options[1].version;
      break;
    }
    if (answer === '3') {
      newVersion = options[2].version;
      break;
    }
    if (answer === '4') {
      const custom = (await rl.question('Enter version (X.Y.Z): ')).trim();
      if (/^\d+\.\d+\.\d+$/.test(custom)) {
        newVersion = custom;
        break;
      }
      console.log('Invalid format. Use X.Y.Z');
      continue;
    }
    console.log('Please enter 1, 2, 3, or 4');
  }
  rl.close();
  return newVersion;
}

function openEditorForReview(section: string): string {
  const editor = process.env.EDITOR!;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-'));
  const tmpFile = path.join(tmpDir, 'CHANGELOG.md');
  fs.writeFileSync(tmpFile, section, 'utf-8');
  printLog(`Opening $EDITOR (${editor}) for changelog review...`);
  // $EDITOR may contain arguments (e.g. "code --wait") — pass as array so command handles splitting.
  command`${[...editor.split(' '), tmpFile]}`.withLogs().run();
  return fs.readFileSync(tmpFile, 'utf-8');
}

function applyChanges(newVersion: string, editedSection: string): void {
  // Insert new section after the file header, before the first existing version entry.
  const existing = fs.existsSync(CHANGELOG_PATH) ? fs.readFileSync(CHANGELOG_PATH, 'utf-8') : '';
  const firstSectionIndex = existing.search(/^## /m);
  const updatedChangelog =
    firstSectionIndex === -1
      ? existing + (existing.endsWith('\n') ? '' : '\n') + editedSection
      : existing.slice(0, firstSectionIndex) + editedSection + '\n' + existing.slice(firstSectionIndex);
  fs.writeFileSync(CHANGELOG_PATH, updatedChangelog, 'utf-8');

  // Bump version in root package.json only.
  // (We read/write the root directly rather than using findPackageJsonFiles because
  //  we only need to modify the published package, not the workspace packages.)
  const pkg = JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, 'utf-8'));
  pkg.version = newVersion;
  fs.writeFileSync(PACKAGE_JSON_PATH, JSON.stringify(pkg, null, 2) + '\n', 'utf-8');

  // Regenerate lock file in case the version bump affects workspace resolution.
  printLog('Regenerating lock file...');
  command`yarn install`.withLogs().run();
}

function createReleaseBranchAndPR(newVersion: string): string {
  const branch = `release/v${newVersion}`;
  command`git checkout -b ${branch}`.withLogs().run();
  command`git add ${CHANGELOG_PATH} ${PACKAGE_JSON_PATH} ${YARN_LOCK_PATH}`.run();
  command`git commit -m v${newVersion}`.run();
  command`git push origin ${branch}`.withLogs().run();

  printLog('Creating release tag...');
  command`git tag -a v${newVersion} -m v${newVersion}`.withLogs().run();
  command`git push origin v${newVersion}`.withLogs().run();

  printLog('Creating GitHub PR...');
  return command`gh pr create --title v${newVersion} --body ${''} --base main`.run().trim();
}
