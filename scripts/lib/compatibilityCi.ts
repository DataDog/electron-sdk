import { stringify } from 'yaml';
import type { CompatibilityConfig, CompatibilityTarget } from './compatibility.ts';

interface CompatibilityJob {
  variables: Record<string, string>;
  script: string[];
  after_script?: string[];
  artifacts: { when: 'always'; paths: string[] };
}

interface CompatibilityEnvironment {
  id: string;
  runnerTags: string[];
  image?: string;
  /** Platform-specific fields merged into the shared compatibility job. */
  job: (target: CompatibilityTarget) => CompatibilityJob;
}

export const environments: CompatibilityEnvironment[] = [
  { id: 'linux', runnerTags: ['arch:amd64'], image: '$CI_IMAGE', job: shellJob(['xvfb-run', '-a']) },
  { id: 'macos', runnerTags: ['macos:sequoia-arm64', 'specific:true'], job: shellJob([]) },
  { id: 'windows', runnerTags: ['windows-v2:2022'], job: windowsContainerJob },
];

function shellJob(testCommandPrefix: string[]): CompatibilityEnvironment['job'] {
  return (target) => ({
    variables: { npm_config_cache: '$CI_PROJECT_DIR/.npm-cache/$CI_JOB_ID' },
    script: [
      'mkdir -p logs',
      'set -o pipefail',
      'ELECTRON_SKIP_BINARY_DOWNLOAD=1 yarn install --immutable 2>&1 | tee logs/01-yarn-install.log',
      `yarn test:compatibility:init ${target.id} 2>&1 | tee logs/02-compatibility-init.log`,
      `${[...testCommandPrefix, 'yarn', 'test:compatibility', target.id].join(' ')} 2>&1 | tee logs/03-compatibility-tests.log`,
    ],
    artifacts: {
      when: 'always',
      paths: ['logs/', 'test-results/', 'playwright-report/', 'e2e/compatibility/generated/*/metadata.json'],
    },
  });
}

function windowsContainerJob(target: CompatibilityTarget): CompatibilityJob {
  return {
    // Request a fresh checkout for each job, following other Datadog SDKs on Windows runners.
    // https://docs.gitlab.com/ci/runners/configure_runners/#git-strategy
    variables: { OVERRIDE_GIT_STRATEGY: 'clone' },
    script: [
      `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ci/windows/run.ps1 -Target ${target.id}`,
    ],
    // after_script still runs when the job times out, unlike the finally block in run.ps1.
    after_script: [
      [
        "$ErrorActionPreference = 'Continue'",
        'docker rm --force "electron-sdk-tests-$env:CI_JOB_ID" 2>$null',
        'docker image rm --no-prune "electron-sdk-windows-tests:$env:CI_JOB_ID" 2>$null',
        '$global:LASTEXITCODE = 0',
        '',
      ].join('\n'),
    ],
    artifacts: { when: 'always', paths: ['windows-test-artifacts/'] },
  };
}

export function parseCompatibilityCiFilters(config: CompatibilityConfig, env = process.env) {
  return {
    environments: select(environments, env.DD_ELECTRON_COMPATIBILITY_ENVIRONMENTS),
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
  const pipeline: Record<string, unknown> = { stages: ['test'] };
  for (const environment of filters.environments) {
    for (const target of filters.targets) {
      const { variables, ...job } = environment.job(target);
      pipeline[`${environment.id}:${target.id}`] = {
        stage: 'test',
        interruptible: true,
        timeout: '2h',
        tags: [...environment.runnerTags],
        ...(environment.image ? { image: environment.image } : {}),
        variables: { YARN_ENABLE_INLINE_BUILDS: 'true', ...variables },
        ...job,
      };
    }
  }
  // Preserve string scalars for both YAML 1.1 and 1.2 readers; keep shell commands on one line.
  return `# Generated compatibility pipeline\n${stringify(pipeline, { compat: 'yaml-1.1', lineWidth: 0 })}`;
}
