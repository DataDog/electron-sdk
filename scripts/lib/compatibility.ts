import fs from 'node:fs';
import path from 'node:path';

export type CompatibilityParameter = boolean | number | string | null | CompatibilityParameterObject;

export interface CompatibilityParameterObject {
  [name: string]: CompatibilityParameter;
}

export interface CompatibilityTarget {
  id: string;
  ci?: {
    allowFailure?: boolean;
  };
  dimensions: CompatibilityParameterObject;
}

export interface CompatibilityEnvironment {
  id: string;
  runnerTags: string[];
  image?: string;
  testCommandPrefix: string[];
}

export interface CompatibilityAppVariant {
  id: string;
  parameters: CompatibilityParameterObject;
  modes: string[];
}

export interface CompatibilityAppTemplate {
  id: string;
  kind: 'e2e' | 'integration';
  source: string;
  parameters: CompatibilityParameterObject;
  variants: CompatibilityAppVariant[];
}

export interface CompatibilityOverride {
  id: string;
  when: {
    targets: string[];
    templates: string[];
  };
  source: string;
  remove?: string[];
}

export interface CompatibilityConfig {
  environments: CompatibilityEnvironment[];
  targets: CompatibilityTarget[];
  appTemplates: CompatibilityAppTemplate[];
  overrides: CompatibilityOverride[];
}

export interface ElectronDimension extends CompatibilityParameterObject {
  dependency: string;
  version: string;
  channel: string;
}

const repositoryRoot = path.join(import.meta.dirname, '../..');
const compatibilityConfigPath = path.join(repositoryRoot, 'e2e/compatibility/config.json');

export function getRepositoryRoot(): string {
  return repositoryRoot;
}

export function loadCompatibilityConfig(): CompatibilityConfig {
  const config = JSON.parse(fs.readFileSync(compatibilityConfigPath, 'utf8')) as CompatibilityConfig;
  validateCompatibilityConfig(config);
  return config;
}

export function getCompatibilityTarget(config: CompatibilityConfig, targetId: string): CompatibilityTarget {
  const target = config.targets.find(({ id }) => id === targetId);
  if (!target) {
    throw new Error(
      `Unknown compatibility target "${targetId}". Available targets: ${config.targets.map(({ id }) => id).join(', ')}`
    );
  }
  return target;
}

export function getElectronDimension(target: CompatibilityTarget): ElectronDimension {
  const electron = target.dimensions.electron;
  if (!electron || typeof electron !== 'object') {
    throw new Error(`Compatibility target "${target.id}" has no electron dimension.`);
  }

  const { dependency, version, channel } = electron;
  if (typeof dependency !== 'string' || typeof version !== 'string' || typeof channel !== 'string') {
    throw new Error(`Compatibility target "${target.id}" has an invalid electron dimension.`);
  }
  return electron as ElectronDimension;
}

export function getElectronDependencySpecifier(target: CompatibilityTarget): string {
  const { dependency, version } = getElectronDimension(target);
  return dependency === 'electron' ? version : `npm:${dependency}@${version}`;
}

export function getGeneratedTargetRoot(targetId: string): string {
  assertSafeIdentifier(targetId, 'compatibility target');
  return path.join(repositoryRoot, 'e2e/compatibility/generated', targetId);
}

export function updatePackageManifest(
  manifest: Record<string, unknown>,
  electronDependencySpecifier: string,
  sdkDependencySpecifier: string
): Record<string, unknown> {
  const devDependencies = asDependencyRecord(manifest.devDependencies, 'devDependencies');
  const dependencies = asDependencyRecord(manifest.dependencies, 'dependencies');

  return {
    ...manifest,
    dependencies: {
      ...dependencies,
      '@datadog/electron-sdk': sdkDependencySpecifier,
    },
    devDependencies: {
      ...devDependencies,
      electron: electronDependencySpecifier,
    },
  };
}

export function validateCompatibilityConfig(config: CompatibilityConfig): void {
  if (!Array.isArray(config.targets) || !config.targets.length) {
    throw new Error('Compatibility config must define at least one target.');
  }
  if (!Array.isArray(config.environments) || !config.environments.length) {
    throw new Error('Compatibility config must define at least one execution environment.');
  }
  if (!Array.isArray(config.appTemplates) || !config.appTemplates.length) {
    throw new Error('Compatibility config must define at least one app template.');
  }
  if (!Array.isArray(config.overrides)) {
    throw new Error('Compatibility config overrides must be an array.');
  }

  validateUniqueIdentifiers(config.environments, 'execution environment');
  validateUniqueIdentifiers(config.targets, 'target');
  validateUniqueIdentifiers(config.appTemplates, 'app template');
  validateUniqueIdentifiers(config.overrides, 'override');

  for (const environment of config.environments) {
    assertSafeIdentifier(environment.id, 'compatibility execution environment');
    if (!Array.isArray(environment.runnerTags) || !environment.runnerTags.length) {
      throw new Error(`Compatibility execution environment "${environment.id}" must define runner tags.`);
    }
    if (!Array.isArray(environment.testCommandPrefix)) {
      throw new Error(`Compatibility execution environment "${environment.id}" has an invalid test command prefix.`);
    }
  }
  for (const target of config.targets) {
    assertSafeIdentifier(target.id, 'compatibility target');
    getElectronDimension(target);
  }
  for (const template of config.appTemplates) {
    assertSafeIdentifier(template.id, 'compatibility app template');
    const templateKind = String(template.kind);
    if (templateKind !== 'e2e' && templateKind !== 'integration') {
      throw new Error(`Compatibility app template "${template.id}" has invalid kind "${templateKind}".`);
    }
    if (!template.variants.length) {
      throw new Error(`Compatibility app template "${template.id}" must define at least one variant.`);
    }
    validateUniqueIdentifiers(template.variants, `variant in ${template.id}`);
  }
  for (const override of config.overrides) {
    validateCompatibilityOverride(override, config);
  }
}

function validateCompatibilityOverride(override: CompatibilityOverride, config: CompatibilityConfig): void {
  assertSafeIdentifier(override.id, 'compatibility override');
  if (!override.when || !Array.isArray(override.when.targets) || !override.when.targets.length) {
    throw new Error(`Compatibility override "${override.id}" must select at least one target.`);
  }
  if (!Array.isArray(override.when.templates) || !override.when.templates.length) {
    throw new Error(`Compatibility override "${override.id}" must select at least one app template.`);
  }

  validateReferences(override.when.targets, config.targets, 'target', override.id);
  validateReferences(override.when.templates, config.appTemplates, 'app template', override.id);
  assertSafeRelativePath(override.source, `source for compatibility override "${override.id}"`);
  for (const removal of override.remove ?? []) {
    assertSafeRelativePath(removal, `removal for compatibility override "${override.id}"`);
  }
}

function validateReferences(references: string[], available: { id: string }[], kind: string, overrideId: string): void {
  const availableIds = new Set(available.map(({ id }) => id));
  const unknown = references.filter((reference) => !availableIds.has(reference));
  if (unknown.length) {
    throw new Error(`Compatibility override "${overrideId}" references unknown ${kind}(s): ${unknown.join(', ')}.`);
  }
}

function validateUniqueIdentifiers(items: { id: string }[], kind: string): void {
  const seen = new Set<string>();
  for (const { id } of items) {
    if (seen.has(id)) throw new Error(`Duplicate compatibility ${kind} id "${id}".`);
    seen.add(id);
  }
}

function assertSafeIdentifier(identifier: string, kind: string): void {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(identifier)) {
    throw new Error(`Invalid ${kind} identifier "${identifier}".`);
  }
}

export function assertSafeRelativePath(relativePath: string, kind: string): void {
  if (!relativePath || path.isAbsolute(relativePath) || path.win32.isAbsolute(relativePath)) {
    throw new Error(`Invalid ${kind} path "${relativePath}".`);
  }
  const normalized = path.posix.normalize(relativePath.replaceAll('\\', '/'));
  if (normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
    throw new Error(`Invalid ${kind} path "${relativePath}".`);
  }
}

function asDependencyRecord(value: unknown, field: string): Record<string, string> {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Expected package.json ${field} to be an object.`);
  }
  return value as Record<string, string>;
}
