import fs from 'node:fs';
import path from 'node:path';

export interface CompatibilityTarget {
  id: string;
  dependency: string;
  version: string;
  channel: string;
  allowFailure?: boolean;
}
export interface CompatibilityEnvironment {
  id: string;
  runnerTags: string[];
  image?: string;
  testCommandPrefix: string[];
}
export interface CompatibilityConfig {
  environments: CompatibilityEnvironment[];
  targets: CompatibilityTarget[];
  apps: string[];
}

export function getRepositoryRoot(): string {
  return path.join(import.meta.dirname, '../..');
}
export function loadCompatibilityConfig(): CompatibilityConfig {
  return JSON.parse(
    fs.readFileSync(path.join(getRepositoryRoot(), 'e2e/compatibility/config.json'), 'utf8')
  ) as CompatibilityConfig;
}
export function getCompatibilityTarget(config: CompatibilityConfig, id: string): CompatibilityTarget {
  const target = config.targets.find((target) => target.id === id);
  if (!target)
    throw new Error(`Unknown compatibility target: ${id}. Choose ${config.targets.map((t) => t.id).join(', ')}.`);
  return target;
}
export function getGeneratedTargetRoot(id: string): string {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) throw new Error(`Invalid target id: ${id}`);
  return path.join(getRepositoryRoot(), 'e2e/compatibility/generated', id);
}

/** Copies a maintained app without its local dependencies or build output. */
export async function materializeApp(
  source: string,
  destination: string,
  target: CompatibilityTarget,
  sdk: string
): Promise<void> {
  const ignored = new Set([
    '.yarn',
    '.vite',
    '.webpack',
    'dist',
    'out',
    'node_modules',
    'test-results',
    'playwright-report',
  ]);
  await fs.promises.cp(source, destination, {
    recursive: true,
    filter: (entry) => !ignored.has(path.basename(entry)) && !entry.endsWith('.tsbuildinfo'),
  });
  const manifestPath = path.join(destination, 'package.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.dependencies['@datadog/electron-sdk'] = sdk;
  manifest.devDependencies.electron =
    target.dependency === 'electron' ? target.version : `npm:${target.dependency}@${target.version}`;
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const yarnConfigPath = path.join(destination, '.yarnrc.yml');
  const config = fs.existsSync(yarnConfigPath) ? fs.readFileSync(yarnConfigPath, 'utf8') : 'nodeLinker: node-modules\n';
  const entry = `  - ${target.dependency}@${target.version}\n`;
  fs.writeFileSync(
    yarnConfigPath,
    config.includes('npmPreapprovedPackages:\n')
      ? config.replace('npmPreapprovedPackages:\n', `npmPreapprovedPackages:\n${entry}`)
      : `${config.trimEnd()}\n\nnpmPreapprovedPackages:\n${entry}`
  );
}
