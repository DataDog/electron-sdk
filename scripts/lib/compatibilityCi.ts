import type { CompatibilityConfig } from './compatibility.ts';

export function parseCompatibilityCiFilters(config: CompatibilityConfig, env = process.env) {
  return {
    environments: select(config.environments, env.DD_ELECTRON_COMPATIBILITY_ENVIRONMENTS),
    targets: select(config.targets, env.DD_ELECTRON_COMPATIBILITY_TARGETS),
  };
}
function select<T extends { id: string }>(items: T[], filter?: string): T[] {
  if (!filter?.trim()) return items;
  const ids = new Set(filter.split(',').map((id) => id.trim()));
  for (const id of ids)
    if (!items.some((item) => item.id === id)) throw new Error(`Unknown compatibility selection: ${id}`);
  return items.filter((item) => ids.has(item.id));
}
export function generateCompatibilityCi(
  config: CompatibilityConfig,
  filters = parseCompatibilityCiFilters(config, {})
): string {
  const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
  const lines = ['# Generated compatibility pipeline', 'stages: [test]'];
  for (const environment of filters.environments) {
    for (const target of filters.targets) {
      lines.push(
        `${environment.id}:${target.id}:`,
        '  stage: test',
        '  interruptible: true',
        '  timeout: 2h',
        '  tags:',
        ...environment.runnerTags.map((tag) => `    - ${quote(tag)}`),
        ...(environment.image ? [`  image: ${quote(environment.image)}`] : []),
        ...(target.allowFailure ? ['  allow_failure: true'] : []),
        '  variables:',
        "    YARN_ENABLE_INLINE_BUILDS: 'true'",
        "    npm_config_cache: '$CI_PROJECT_DIR/.npm-cache/$CI_JOB_ID'",
        '  script:',
        '    - mkdir -p logs',
        '    - set -o pipefail',
        '    - ELECTRON_SKIP_BINARY_DOWNLOAD=1 yarn install --immutable 2>&1 | tee logs/01-yarn-install.log',
        `    - yarn test:compatibility:init ${target.id} 2>&1 | tee logs/02-compatibility-init.log`,
        `    - ${[...environment.testCommandPrefix, 'yarn', 'test:compatibility', target.id].join(' ')} 2>&1 | tee logs/03-compatibility-tests.log`,
        '  artifacts:',
        '    when: always',
        '    paths:',
        '      - logs/',
        '      - test-results/',
        '      - playwright-report/',
        '      - e2e/compatibility/generated/*/metadata.json'
      );
    }
  }
  return `${lines.join('\n')}\n`;
}
