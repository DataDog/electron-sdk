import type { CompatibilityConfig, CompatibilityEnvironment, CompatibilityTarget } from './compatibility.ts';

const ENVIRONMENT_FILTER_VARIABLE = 'DD_ELECTRON_COMPATIBILITY_ENVIRONMENTS';
const TARGET_FILTER_VARIABLE = 'DD_ELECTRON_COMPATIBILITY_TARGETS';

export interface CompatibilityCiFilters {
  environmentIds?: string[];
  targetIds?: string[];
}

export function parseCompatibilityCiFilters(
  config: CompatibilityConfig,
  environment: Record<string, string | undefined> = process.env
): CompatibilityCiFilters {
  return {
    environmentIds: parseIdentifierFilter(
      environment[ENVIRONMENT_FILTER_VARIABLE],
      config.environments,
      ENVIRONMENT_FILTER_VARIABLE,
      'environment'
    ),
    targetIds: parseIdentifierFilter(
      environment[TARGET_FILTER_VARIABLE],
      config.targets,
      TARGET_FILTER_VARIABLE,
      'target'
    ),
  };
}

export function generateCompatibilityCi(config: CompatibilityConfig, filters: CompatibilityCiFilters = {}): string {
  const lines = ['# Generated from e2e/compatibility/config.json. Do not edit.', '', 'stages:', '  - test', ''];
  const environments = selectItems(config.environments, filters.environmentIds);
  const targets = selectItems(config.targets, filters.targetIds);

  for (const environment of environments) {
    for (const target of targets) {
      lines.push(...generateJob(environment, target), '');
    }
  }

  return `${lines.join('\n')}\n`;
}

function generateJob(environment: CompatibilityEnvironment, target: CompatibilityTarget): string[] {
  const testCommand = [...environment.testCommandPrefix, 'yarn', 'test:compatibility', target.id].join(' ');
  const lines = [
    `${environment.id}:${target.id}:`,
    '  stage: test',
    '  interruptible: true',
    '  timeout: 2h',
    '  tags:',
    ...environment.runnerTags.map((tag) => `    - ${quoteYaml(tag)}`),
  ];

  if (environment.image) lines.push(`  image: ${quoteYaml(environment.image)}`);
  if (target.ci?.allowFailure) lines.push('  allow_failure: true');

  lines.push(
    '  variables:',
    `    DD_ELECTRON_COMPATIBILITY_ENVIRONMENT: ${quoteYaml(environment.id)}`,
    `    DD_ELECTRON_COMPATIBILITY_TARGET: ${quoteYaml(target.id)}`,
    '  script:',
    '    - yarn install --immutable',
    `    - yarn test:compatibility:init ${target.id}`,
    `    - ${testCommand}`,
    '  artifacts:',
    '    when: on_failure',
    '    paths:',
    '      - e2e/test-results/',
    '      - e2e/playwright-report/',
    '      - e2e/compatibility/generated/*/metadata.json'
  );
  return lines;
}

function quoteYaml(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function parseIdentifierFilter(
  value: string | undefined,
  available: { id: string }[],
  variable: string,
  kind: string
): string[] | undefined {
  if (!value?.trim()) return undefined;

  const identifiers = value.split(',').map((identifier) => identifier.trim());
  if (identifiers.some((identifier) => !identifier)) {
    throw new Error(`${variable} must be a comma-separated list without empty ${kind} identifiers.`);
  }

  const uniqueIdentifiers = [...new Set(identifiers)];
  const availableIdentifiers = new Set(available.map(({ id }) => id));
  const unknownIdentifiers = uniqueIdentifiers.filter((identifier) => !availableIdentifiers.has(identifier));
  if (unknownIdentifiers.length) {
    throw new Error(
      `Unknown compatibility ${kind}(s) in ${variable}: ${unknownIdentifiers.join(', ')}. Available ${kind}s: ${available
        .map(({ id }) => id)
        .join(', ')}`
    );
  }
  return uniqueIdentifiers;
}

function selectItems<T extends { id: string }>(items: T[], selectedIdentifiers: string[] | undefined): T[] {
  if (!selectedIdentifiers) return items;
  const selected = new Set(selectedIdentifiers);
  return items.filter(({ id }) => selected.has(id));
}
