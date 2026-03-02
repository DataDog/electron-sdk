import { displayError } from './tools/display';

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

export const BatchSizes = {
  SMALL: 16 * 1024,
  MEDIUM: 512 * 1024,
  LARGE: 4 * 1024 * 1024,
} as const;

export const BatchUploadFrequencies = {
  RARE: 30 * 1000,
  NORMAL: 10 * 1000,
  FREQUENT: 5 * 1000,
} as const;

export type BatchSize = 'SMALL' | 'MEDIUM' | 'LARGE';
export type UploadFrequency = 'RARE' | 'NORMAL' | 'FREQUENT';

export interface InitConfiguration {
  site: string;
  proxy?: string;
  service: string;
  clientToken: string;
  applicationId: string;
  env?: string;
  version?: string;
  telemetrySampleRate?: number;
  batchSize?: BatchSize;
  uploadFrequency?: UploadFrequency;
}

export interface Configuration {
  site: string;
  service: string;
  clientToken: string;
  applicationId: string;
  env?: string;
  version?: string;
  proxy?: string;
  intakeUrl: string;
  telemetrySampleRate: number;
  batchSize?: BatchSize;
  uploadFrequency?: UploadFrequency;
}

function validateRequiredString(value: unknown, fieldName: string): string | undefined {
  if (typeof value !== 'string' || value.length === 0) {
    displayError(`Configuration error: '${fieldName}' must be a non-empty string`);
    return undefined;
  }
  return value;
}

function validateSite(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || !(VALID_DATADOG_SITES as readonly string[]).includes(value)) {
    displayError(`Configuration error: 'site' must be one of: ${VALID_DATADOG_SITES.join(', ')}`);
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

function validateTelemetrySampleRate(value: unknown): number {
  if (value === undefined || value === null) {
    return 20;
  }
  if (typeof value !== 'number' || value < 0 || value > 100) {
    displayError("Configuration error: 'telemetrySampleRate' must be a number between 0 and 100");
    return 20;
  }
  return value;
}

export function buildConfiguration(initConfig: InitConfiguration): Configuration | undefined {
  const service = validateRequiredString(initConfig.service, 'service');
  const clientToken = validateRequiredString(initConfig.clientToken, 'clientToken');
  const applicationId = validateRequiredString(initConfig.applicationId, 'applicationId');
  const site = validateSite(initConfig.site);

  if (service === undefined || clientToken === undefined || applicationId === undefined || site === undefined) {
    return undefined;
  }

  const proxy = validateOptionalString(initConfig.proxy);

  return {
    site,
    service,
    clientToken,
    applicationId,
    env: validateOptionalString(initConfig.env),
    version: validateOptionalString(initConfig.version),
    proxy,
    intakeUrl: computeIntakeUrl(site, proxy),
    telemetrySampleRate: validateTelemetrySampleRate(initConfig.telemetrySampleRate),
  };
}

function computeIntakeUrl(site: string, proxy?: string): string {
  // Proxy takes precedence - allows users to override the intake URL
  if (proxy) {
    return proxy;
  }

  return computeIntakeUrlForTrack(site, 'rum');
}

export function computeIntakeUrlForTrack(site: string, trackType: string): string {
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

  return `https://browser-intake-${intakeSite}/api/v2/${trackType}`;
}
