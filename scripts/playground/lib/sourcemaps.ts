import { parseArgs } from 'node:util';

export interface UploadTarget {
  service: string;
  minifiedPathPrefix: string;
}

// One renderer upload per way the playground can serve its renderer (app://, http origin, file:// once the SDK strips
// the app path), and one main-process upload for the stripped app path.
export const UPLOAD_TARGETS: UploadTarget[] = [
  { service: 'playground-renderer', minifiedPathPrefix: 'app://app/' },
  { service: 'playground-renderer', minifiedPathPrefix: '/' },
  { service: 'playground-renderer', minifiedPathPrefix: '/dist/' },
  { service: 'playground-main', minifiedPathPrefix: '/dist/' },
];

const REPOSITORY_URL = 'https://github.com/DataDog/electron-sdk';

// Keep aligned with playground/src/main/conf.ts.
export const PLAYGROUND_SITES: Record<string, string> = {
  staging: 'datad0g.com',
  prod: 'datadoghq.com',
};

export function buildUploadArgs(target: UploadTarget, version: string, dryRun: boolean): string[] {
  return [
    'sourcemaps',
    'upload',
    './dist',
    '--service',
    target.service,
    '--release-version',
    version,
    '--minified-path-prefix',
    target.minifiedPathPrefix,
    '--repository-url',
    REPOSITORY_URL,
    ...(dryRun ? ['--dry-run'] : []),
  ];
}

export function parseUploadOptions(
  argv: string[],
  env: NodeJS.ProcessEnv
): { site: string; dryRun: boolean; apiKey: string } {
  const { values } = parseArgs({ args: argv, options: { 'dry-run': { type: 'boolean', default: false } } });
  const playgroundEnv = env.PLAYGROUND_ENV ?? 'staging';
  const site = Object.hasOwn(PLAYGROUND_SITES, playgroundEnv) ? PLAYGROUND_SITES[playgroundEnv] : undefined;
  if (!site) {
    throw new Error(
      `Unknown PLAYGROUND_ENV "${playgroundEnv}", expected ${Object.keys(PLAYGROUND_SITES).join(' or ')}`
    );
  }
  const dryRun = values['dry-run'];
  const apiKey = env.DATADOG_API_KEY ?? (dryRun ? 'dry-run' : undefined);
  if (!apiKey) {
    throw new Error('DATADOG_API_KEY is not set');
  }
  return { site, dryRun, apiKey };
}
