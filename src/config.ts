const VALID_DATADOG_SITES = [
  'datadoghq.com',
  'datadoghq.eu',
  'us3.datadoghq.com',
  'us5.datadoghq.com',
  'ap1.datadoghq.com',
  'ap2.datadoghq.com',
  'ddog-gov.com',
  'datad0g.com', // Internal staging site
] as const;

export interface InitConfiguration {
  site: string;
  proxy?: string;
  service: string;
  clientToken: string;
  env?: string;
  version?: string;
}

export interface Configuration {
  service: string;
  clientToken: string;
  env?: string;
  version?: string;
  intakeUrl: string;
}

function validateRequiredString(value: unknown, fieldName: string): string | undefined {
  if (typeof value !== 'string' || value.length === 0) {
    console.error(`Configuration error: '${fieldName}' must be a non-empty string`);
    return undefined;
  }
  return value;
}

function validateSite(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || !VALID_DATADOG_SITES.includes(value as any)) {
    console.error(`Configuration error: 'site' must be one of: ${VALID_DATADOG_SITES.join(', ')}`);
    return undefined;
  }
  return value;
}

function validateOptionalString(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value !== 'string') {
    return undefined;
  }

  return value.length > 0 ? value : undefined;
}

export function buildConfiguration(initConfig: InitConfiguration): Configuration | undefined {
  const service = validateRequiredString(initConfig.service, 'service');
  const clientToken = validateRequiredString(initConfig.clientToken, 'clientToken');
  const site = validateSite(initConfig.site);

  if (service === undefined || clientToken === undefined || site === undefined) {
    return undefined;
  }

  const env = validateOptionalString(initConfig.env);
  const version = validateOptionalString(initConfig.version);
  const proxy = validateOptionalString(initConfig.proxy);

  const intakeUrl = computeIntakeUrl(site, proxy);

  return {
    service,
    clientToken,
    env,
    version,
    intakeUrl,
  };
}

function computeIntakeUrl(site: string, proxy?: string): string {
  // Proxy takes precedence - allows users to override the intake URL
  if (proxy) {
    return proxy;
  }

  // Generate intake URL from site
  // For sites with subdomains (e.g., us3.datadoghq.com), replace the first dot with a dash
  const parts = site.split('.');
  let intakeSite: string;

  if (parts.length > 2) {
    // Has subdomain (e.g., us3.datadoghq.com -> us3-datadoghq.com)
    const subdomain = parts[0];
    const rest = parts.slice(1).join('.');
    intakeSite = `${subdomain}-${rest}`;
  } else {
    // No subdomain (e.g., datadoghq.com, ddog-gov.com)
    intakeSite = site;
  }

  return `https://browser-intake-${intakeSite}/api/v2/rum`;
}
