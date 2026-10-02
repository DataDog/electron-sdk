// Keep the env → site mapping aligned with PLAYGROUND_SITES in scripts/playground/lib/sourcemaps.ts.
const CONF = {
  staging: {
    applicationId: '6efd3722-af0a-4070-994c-0e87076d4814',
    clientToken: 'pub2a7307cdec74934cacb411a193f632f8',
    site: 'datad0g.com',
  },
  prod: {
    applicationId: '0f574f27-317e-4223-b5b6-c935b4c83700',
    clientToken: 'pub09a54e493460355ef58c0c617d577e19',
    site: 'datadoghq.com',
  },
};

type PlaygroundEnv = keyof typeof CONF;

/** Datadog configuration selected by PLAYGROUND_ENV (staging | prod, default staging). */
export function getActiveConf(): (typeof CONF)[PlaygroundEnv] {
  const env = process.env.PLAYGROUND_ENV ?? 'staging';
  if (!isPlaygroundEnv(env)) {
    throw new Error(`Unknown PLAYGROUND_ENV "${env}", expected ${Object.keys(CONF).join(' or ')}`);
  }
  return CONF[env];
}

function isPlaygroundEnv(value: string): value is PlaygroundEnv {
  return Object.prototype.hasOwnProperty.call(CONF, value);
}
