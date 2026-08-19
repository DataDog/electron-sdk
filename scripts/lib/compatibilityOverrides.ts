import fs from 'node:fs';
import path from 'node:path';

import {
  assertSafeRelativePath,
  getRepositoryRoot,
  type CompatibilityConfig,
  type CompatibilityOverride,
} from './compatibility.ts';
import { printLog } from './executionUtils.ts';

export function applyCompatibilityOverrides(
  config: CompatibilityConfig,
  targetId: string,
  templateId: string,
  destination: string,
  repositoryRoot = getRepositoryRoot()
): CompatibilityOverride[] {
  const matchingOverrides = config.overrides.filter(
    ({ when }) => when.targets.includes(targetId) && when.templates.includes(templateId)
  );

  for (const override of matchingOverrides) {
    const source = resolveRepositoryPath(
      repositoryRoot,
      override.source,
      `source for compatibility override "${override.id}"`
    );
    if (!fs.statSync(source, { throwIfNoEntry: false })?.isDirectory()) {
      throw new Error(`Compatibility override "${override.id}" source directory not found at ${source}.`);
    }

    printLog(`Applying compatibility override ${override.id} to ${templateId}`);
    fs.cpSync(source, destination, { recursive: true, force: true });

    for (const removal of override.remove ?? []) {
      const removalPath = resolveDestinationPath(destination, removal, override.id);
      fs.rmSync(removalPath, { recursive: true, force: true });
    }
  }

  return matchingOverrides;
}

function resolveRepositoryPath(repositoryRoot: string, relativePath: string, kind: string): string {
  assertSafeRelativePath(relativePath, kind);
  return path.join(repositoryRoot, relativePath);
}

function resolveDestinationPath(destination: string, relativePath: string, overrideId: string): string {
  assertSafeRelativePath(relativePath, `removal for compatibility override "${overrideId}"`);
  const resolvedDestination = path.resolve(destination);
  const resolvedRemoval = path.resolve(destination, relativePath);
  if (resolvedRemoval === resolvedDestination || !resolvedRemoval.startsWith(`${resolvedDestination}${path.sep}`)) {
    throw new Error(`Compatibility override "${overrideId}" removal escapes its app destination: ${relativePath}.`);
  }
  return resolvedRemoval;
}
