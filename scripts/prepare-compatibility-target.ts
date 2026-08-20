/**
 * Materializes the maintained E2E and integration app templates for one compatibility target.
 *
 * Usage:
 *   node scripts/prepare-compatibility-target.ts electron-41
 *   node scripts/prepare-compatibility-target.ts electron-41 --template minimal-e2e
 *   node scripts/prepare-compatibility-target.ts electron-41 --sdk-tarball ./compatibility-sdk.tgz
 *   node scripts/prepare-compatibility-target.ts electron-41 --sdk-ref my-sdk-branch
 */
import fs from 'node:fs';
import path from 'node:path';

import {
  getCompatibilityTarget,
  getElectronDependencySpecifier,
  getElectronDimension,
  getGeneratedTargetRoot,
  getRepositoryRoot,
  loadCompatibilityConfig,
  updatePackageManifest,
  type CompatibilityAppTemplate,
  type CompatibilityAppVariant,
  type CompatibilityParameterObject,
} from './lib/compatibility.ts';
import { applyCompatibilityOverrides } from './lib/compatibilityOverrides.ts';
import { prefetchCompatibilityElectronArtifact } from './lib/compatibilityElectronArtifact.ts';
import { parseCompatibilityPreparationOptions } from './lib/compatibilityOptions.ts';
import { prepareSdkTarball } from './lib/compatibilitySdk.ts';
import { command } from './lib/command.ts';
import { printError, printLog, retryWithDelays, runMain } from './lib/executionUtils.ts';

const generatedArtifactNames = new Set([
  '.vite',
  '.webpack',
  'dist',
  'node_modules',
  'out',
  'playwright-report',
  'test-results',
]);
const packageRetryDelays = [2_000, 5_000];

interface MaterializedApp {
  template: CompatibilityAppTemplate;
  variant: CompatibilityAppVariant;
  directory: string;
}

runMain(async () => {
  const options = parseCompatibilityPreparationOptions(process.argv.slice(2));
  const config = loadCompatibilityConfig();
  const target = getCompatibilityTarget(config, options.targetId);
  const electron = getElectronDimension(target);
  const electronDependencySpecifier = getElectronDependencySpecifier(target);
  const templates = selectTemplates(config.appTemplates, options.selectedTemplates);
  const targetRoot = getGeneratedTargetRoot(target.id);
  const sdkTarball = path.join(targetRoot, 'compatibility-sdk.tgz');

  fs.rmSync(targetRoot, { recursive: true, force: true });
  fs.mkdirSync(targetRoot, { recursive: true });
  prepareGeneratedWorkspace(targetRoot);

  const sdkSource = prepareSdkTarball({
    providedTarball: options.sdkTarball,
    sdkRef: options.sdkRef,
    destination: sdkTarball,
  });

  const materializedApps = templates.flatMap((template) =>
    materializeTemplateVariants(
      config,
      targetRoot,
      target.id,
      template,
      electronDependencySpecifier,
      electron.dependency,
      electron.version
    )
  );

  fs.writeFileSync(
    path.join(targetRoot, 'metadata.json'),
    `${JSON.stringify(
      {
        target,
        sdkSource,
        appTemplates: templates,
        materializedApps: materializedApps.map(({ template, variant }) => ({
          template: template.id,
          variant: variant.id,
          parameters: mergeParameters(template.parameters, variant.parameters),
        })),
        generatedAt: new Date().toISOString(),
        platform: process.platform,
        architecture: process.arch,
        nodeVersion: process.version,
      },
      null,
      2
    )}\n`
  );

  if (!options.skipInstall) {
    await prefetchCompatibilityElectronArtifact(target);
    await installAndBuildTemplates(materializedApps);
  }

  printLog(`Compatibility target ${target.id} generated at ${targetRoot}`);
});

function prepareGeneratedWorkspace(targetRoot: string): void {
  // The minimal E2E app inherits this file through ../../tsconfig.base.json. Keep
  // that relationship intact when the app is copied below generated/<target>/.
  const generatedRoot = path.dirname(targetRoot);
  fs.copyFileSync(path.join(getRepositoryRoot(), 'tsconfig.base.json'), path.join(generatedRoot, 'tsconfig.base.json'));
}

function selectTemplates(
  templates: CompatibilityAppTemplate[],
  selectedTemplateIds: string[]
): CompatibilityAppTemplate[] {
  if (!selectedTemplateIds.length) return templates;

  const selected = new Set(selectedTemplateIds);
  const unknown = [...selected].filter((id) => !templates.some((template) => template.id === id));
  if (unknown.length) throw new Error(`Unknown compatibility app template(s): ${unknown.join(', ')}`);
  return templates.filter(({ id }) => selected.has(id));
}

function getTemplateDestination(
  targetRoot: string,
  template: CompatibilityAppTemplate,
  variant: CompatibilityAppVariant
): string {
  return template.kind === 'e2e'
    ? path.join(targetRoot, 'e2e-app')
    : path.join(targetRoot, 'integration-apps', template.id, variant.id);
}

function materializeTemplateVariants(
  config: ReturnType<typeof loadCompatibilityConfig>,
  targetRoot: string,
  targetId: string,
  template: CompatibilityAppTemplate,
  electronDependencySpecifier: string,
  electronDependency: string,
  electronVersion: string
): MaterializedApp[] {
  return template.variants.map((variant) => {
    const destination = getTemplateDestination(targetRoot, template, variant);
    materializeTemplate(
      config,
      targetId,
      template,
      variant,
      destination,
      electronDependencySpecifier,
      electronDependency,
      electronVersion
    );
    return { template, variant, directory: destination };
  });
}

function materializeTemplate(
  config: ReturnType<typeof loadCompatibilityConfig>,
  targetId: string,
  template: CompatibilityAppTemplate,
  variant: CompatibilityAppVariant,
  destination: string,
  electronDependencySpecifier: string,
  electronDependency: string,
  electronVersion: string
): void {
  const source = path.join(getRepositoryRoot(), template.source);
  if (!fs.existsSync(source)) throw new Error(`Compatibility app template source not found at ${source}.`);

  printLog(`Materializing ${template.id}/${variant.id}`);
  fs.cpSync(source, destination, {
    recursive: true,
    filter: (sourcePath) => {
      const name = path.basename(sourcePath);
      return !generatedArtifactNames.has(name) && !name.endsWith('.tsbuildinfo');
    },
  });
  applyCompatibilityOverrides(config, targetId, template.id, destination);

  const manifestPath = path.join(destination, 'package.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
  const sdkDependencySpecifier =
    template.kind === 'e2e' ? 'file:../compatibility-sdk.tgz' : 'file:../../../compatibility-sdk.tgz';
  const updatedManifest = updatePackageManifest(manifest, electronDependencySpecifier, sdkDependencySpecifier);
  fs.writeFileSync(manifestPath, `${JSON.stringify(updatedManifest, null, 2)}\n`);
  preapproveElectronPackage(path.join(destination, '.yarnrc.yml'), electronDependency, electronVersion);
}

function preapproveElectronPackage(yarnConfigPath: string, dependency: string, version: string): void {
  const entry = `  - ${dependency}@${version}`;
  const original = fs.existsSync(yarnConfigPath) ? fs.readFileSync(yarnConfigPath, 'utf8') : '';
  if (original.includes(entry)) return;

  const lines = original.trimEnd().split('\n');
  const keyIndex = lines.findIndex((line) => line === 'npmPreapprovedPackages:');
  if (keyIndex === -1) {
    if (lines.length && lines[0] !== '') lines.push('');
    lines.push('npmPreapprovedPackages:', entry);
  } else {
    let insertionIndex = keyIndex + 1;
    while (insertionIndex < lines.length && /^\s+-\s/.test(lines[insertionIndex])) insertionIndex += 1;
    lines.splice(insertionIndex, 0, entry);
  }
  fs.writeFileSync(yarnConfigPath, `${lines.join('\n')}\n`);
}

async function installAndBuildTemplates(apps: MaterializedApp[]): Promise<void> {
  for (const { template, variant, directory } of apps) {
    const environment = getVariantEnvironment(template, variant);
    printLog(`Installing ${template.id}/${variant.id}`);
    command`yarn install --no-immutable`
      .withCurrentWorkingDirectory(directory)
      .withEnvironment(environment)
      .withLogs()
      .run();

    if (template.kind === 'e2e') {
      printLog(`Building ${template.id}/${variant.id}`);
      command`yarn build`.withCurrentWorkingDirectory(directory).withEnvironment(environment).withLogs().run();
      continue;
    }

    printLog(`Packaging ${template.id}/${variant.id}`);
    await retryWithDelays(
      () => command`yarn package`.withCurrentWorkingDirectory(directory).withEnvironment(environment).withLogs().run(),
      packageRetryDelays,
      (_error, nextAttempt, delay) => {
        printError(
          `Packaging ${template.id}/${variant.id} failed. Retrying attempt ${nextAttempt}/${packageRetryDelays.length + 1} in ${delay / 1_000}s.`
        );
      }
    );
  }
}

function getVariantEnvironment(
  template: CompatibilityAppTemplate,
  variant: CompatibilityAppVariant
): Record<string, string> {
  const parameters = mergeParameters(template.parameters, variant.parameters);
  const environment = {
    DD_ELECTRON_COMPATIBILITY_PARAMETERS: JSON.stringify(parameters),
  } as Record<string, string>;
  const runtimeDependencyStrategy = parameters.runtimeDependencyStrategy;
  if (typeof runtimeDependencyStrategy === 'string') {
    environment.DD_ELECTRON_RUNTIME_DEPENDENCY_STRATEGY = runtimeDependencyStrategy;
  }
  return environment;
}

function mergeParameters(
  templateParameters: CompatibilityParameterObject,
  variantParameters: CompatibilityParameterObject
): CompatibilityParameterObject {
  return { ...templateParameters, ...variantParameters };
}
