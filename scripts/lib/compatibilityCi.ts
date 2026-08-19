import type { CompatibilityConfig, CompatibilityEnvironment, CompatibilityTarget } from './compatibility.ts';

export function generateCompatibilityCi(config: CompatibilityConfig): string {
  const lines = ['# Generated from e2e/compatibility/config.json. Do not edit.', '', 'stages:', '  - test', ''];

  for (const environment of config.environments) {
    for (const target of config.targets) {
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
