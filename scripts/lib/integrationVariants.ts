import fs from 'node:fs';
import path from 'node:path';

export interface IntegrationBuildVariant {
  name: 'default' | 'plugin-copy' | 'bundled';
  copyRuntimeDependencies: boolean;
  bundledMode: boolean;
}

/** Shared configurations for normal integration builds and every compatibility target. */
export function loadIntegrationVariants(): IntegrationBuildVariant[] {
  return JSON.parse(
    fs.readFileSync(path.join(import.meta.dirname, '../../e2e/integration/variants.json'), 'utf8')
  ) as IntegrationBuildVariant[];
}

export function getIntegrationVariantEnvironment(variant: IntegrationBuildVariant): Record<string, string> {
  return {
    DD_ELECTRON_COPY_RUNTIME_DEPENDENCIES: String(variant.copyRuntimeDependencies),
    DD_ELECTRON_BUNDLED_MODE: String(variant.bundledMode),
  };
}
