export type ChangelogCategory =
  | 'breaking'
  | 'features'
  | 'bugfixes'
  | 'documentation'
  | 'performance'
  | 'security'
  | 'internal';

const PUBLIC_CATEGORIES: Record<string, ChangelogCategory> = {
  '✨': 'features',
  '🐛': 'bugfixes',
  '💥': 'breaking',
  '📝': 'documentation',
  '⚡': 'performance',
  '🔒': 'security',
};

const CATEGORY_HEADINGS: Partial<Record<ChangelogCategory, string>> = {
  breaking: '### 💥 Breaking Changes',
  features: '### ✨ Features',
  bugfixes: '### 🐛 Bug Fixes',
  documentation: '### 📝 Documentation',
  performance: '### ⚡ Performance',
  security: '### 🔒 Security',
};

const RELEASE_COMMIT_RE = /^v?\d+\.\d+\.\d+( \(#\d+\))?$/;

export function categorizeCommit(subject: string): ChangelogCategory {
  for (const [emoji, category] of Object.entries(PUBLIC_CATEGORIES)) {
    if (subject.startsWith(emoji)) return category;
  }
  return 'internal';
}

export function generateChangelogSection(version: string, date: string, commits: string[]): string {
  const filtered = commits.filter((s) => !RELEASE_COMMIT_RE.test(s.trim()));

  const byCategory = new Map<ChangelogCategory, string[]>();
  for (const subject of filtered) {
    const category = categorizeCommit(subject);
    if (!byCategory.has(category)) byCategory.set(category, []);
    byCategory.get(category)!.push(subject);
  }

  const publicOrder: ChangelogCategory[] = [
    'breaking',
    'features',
    'bugfixes',
    'documentation',
    'performance',
    'security',
  ];
  const lines: string[] = [`## [${version}] - ${date}`, ''];

  for (const category of publicOrder) {
    const entries = byCategory.get(category);
    if (!entries?.length) continue;
    lines.push(CATEGORY_HEADINGS[category]!);
    entries.forEach((s) => lines.push(`- ${s}`));
    lines.push('');
  }

  const internal = byCategory.get('internal');
  if (internal?.length) {
    lines.push('### Internal');
    internal.forEach((s) => lines.push(`- ${s}`));
    lines.push('');
  }

  return lines.join('\n').trimEnd() + '\n';
}
