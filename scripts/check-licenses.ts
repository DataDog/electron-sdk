import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { printLog, printError, runMain } from './lib/executionUtils.ts';
import { findPackageJsonFiles, type PackageJsonInfo } from './lib/filesUtils.ts';

const LICENSE_FILE = 'LICENSE-3rdparty.csv';
const CARGO_MANIFEST = 'minidump-processor/Cargo.toml';
const KNOWN_COMPONENTS = ['npm-prod', 'npm-dev', 'rust-prod', 'rust-dev'] as const;
type Component = (typeof KNOWN_COMPONENTS)[number];

runMain(async () => {
  const packageJsonFiles = findPackageJsonFiles();
  const filePaths = packageJsonFiles.map((packageJsonFile) => packageJsonFile.relativePath).concat(CARGO_MANIFEST);

  printLog('Looking for dependencies in:\n', filePaths, '\n');

  const licenses = await readLicenseFile();

  checkDependencies('npm-prod', licenses['npm-prod'], retrieveAllNpmDeps(packageJsonFiles, 'dependencies'));
  checkDependencies('npm-dev', licenses['npm-dev'], retrieveAllNpmDeps(packageJsonFiles, 'devDependencies'));
  checkDependencies('rust-prod', licenses['rust-prod'], retrieveCargoDeps('dependencies'));
  checkDependencies('rust-dev', licenses['rust-dev'], retrieveCargoDeps('dev-dependencies'));
});

function checkDependencies(label: string, licensed: string[], declared: string[]): void {
  const sortedLicensed = [...licensed].sort();
  if (JSON.stringify(declared) !== JSON.stringify(sortedLicensed)) {
    printError(`${label} dependencies and ${LICENSE_FILE} mismatch`);
    printError(
      `Declared but not in ${LICENSE_FILE}:\n`,
      declared.filter((d) => !sortedLicensed.includes(d))
    );
    printError(
      `In ${LICENSE_FILE} but not declared:\n`,
      sortedLicensed.filter((d) => !declared.includes(d))
    );
    throw new Error(`${label} dependencies mismatch`);
  }
  printLog(`${label} dependencies check done.`);
}

function retrieveAllNpmDeps(packageJsonFiles: PackageJsonInfo[], field: 'dependencies' | 'devDependencies') {
  return withoutDuplicates(packageJsonFiles.flatMap((file) => retrieveNpmDeps(file, field))).sort();
}

function retrieveNpmDeps(packageJsonFile: { content: any }, field: 'dependencies' | 'devDependencies'): string[] {
  return Object.entries(packageJsonFile.content[field] || {})
    .map(([dependency, version]) => {
      if (typeof version === 'string' && version.startsWith('npm:')) {
        // Extract the original dependency name from the npm protocol version string. Example:
        // npm:react@17  ->  react
        return version.slice(4).split('@')[0];
      }
      return dependency;
    })
    .filter((dependency) => !dependency.includes('@datadog'));
}

function retrieveCargoDeps(section: 'dependencies' | 'dev-dependencies'): string[] {
  const manifestPath = path.join(import.meta.dirname, '..', CARGO_MANIFEST);
  const content = fs.readFileSync(manifestPath, 'utf8');
  const targetSection = `[${section}]`;
  const deps: string[] = [];
  let inSection = false;

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('[')) {
      inSection = trimmed === targetSection;
      continue;
    }
    if (inSection && trimmed && !trimmed.startsWith('#')) {
      const name = trimmed.split('=')[0].trim();
      if (name) deps.push(name);
    }
  }

  return withoutDuplicates(deps).sort();
}

async function readLicenseFile(): Promise<Record<Component, string[]>> {
  const fileStream = fs.createReadStream(path.join(import.meta.dirname, '..', LICENSE_FILE));
  const rl = readline.createInterface({ input: fileStream });
  const result: Record<Component, string[]> = { 'npm-prod': [], 'npm-dev': [], 'rust-prod': [], 'rust-dev': [] };
  let header = true;
  for await (const line of rl) {
    if (!header) {
      const [component, origin] = line.split(',');
      if (!KNOWN_COMPONENTS.includes(component as Component)) {
        throw new Error(`Unknown component in ${LICENSE_FILE}: "${component}"`);
      }
      result[component as Component].push(origin);
    }
    header = false;
  }
  return result;
}

function withoutDuplicates<T>(a: T[]): T[] {
  return [...new Set(a)];
}
