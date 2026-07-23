import { ONE_SECOND } from '@datadog/js-core/time';
import { ONE_KIBI_BYTE, ONE_MEBI_BYTE, DefaultPrivacyLevel } from '@datadog/browser-core';
import { display } from './tools/display';

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
  SMALL: 16 * ONE_KIBI_BYTE,
  MEDIUM: 512 * ONE_KIBI_BYTE,
  LARGE: 4 * ONE_MEBI_BYTE,
} as const;

export const BatchUploadFrequencies = {
  RARE: 30 * ONE_SECOND,
  NORMAL: 10 * ONE_SECOND,
  FREQUENT: 5 * ONE_SECOND,
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
  sessionSampleRate?: number;
  profilingSampleRate?: number;
  telemetrySampleRate?: number;
  batchSize?: BatchSize;
  uploadFrequency?: UploadFrequency;
  defaultPrivacyLevel?: DefaultPrivacyLevel;
  allowedRendererHosts: string[];
}

export interface Configuration {
  site: string;
  service: string;
  clientToken: string;
  applicationId: string;
  env?: string;
  version?: string;
  proxy?: string;
  sessionSampleRate: number;
  profilingSampleRate: number;
  telemetrySampleRate: number;
  batchSize?: BatchSize;
  uploadFrequency?: UploadFrequency;
  defaultPrivacyLevel: DefaultPrivacyLevel;
  allowedRendererHosts: string[];
}

function validateRequiredString(value: unknown, fieldName: string): string | undefined {
  if (typeof value !== 'string' || value.length === 0) {
    display.error(`Configuration error: '${fieldName}' must be a non-empty string`);
    return undefined;
  }
  return value;
}

function validateSite(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || !(VALID_DATADOG_SITES as readonly string[]).includes(value)) {
    display.error(`Configuration error: 'site' must be one of: ${VALID_DATADOG_SITES.join(', ')}`);
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

function validateSessionSampleRate(value: unknown): number | undefined {
  if (value === undefined || value === null) {
    return 100;
  }
  if (!Number.isFinite(value) || (value as number) < 0 || (value as number) > 100) {
    display.error("Configuration error: 'sessionSampleRate' must be a number between 0 and 100");
    return undefined;
  }
  return value as number;
}

function validateProfilingSampleRate(value: unknown): number | undefined {
  if (value === undefined || value === null) {
    return 0;
  }
  if (!Number.isFinite(value) || (value as number) < 0 || (value as number) > 100) {
    display.error("Configuration error: 'profilingSampleRate' must be a number between 0 and 100");
    return undefined;
  }
  return value as number;
}

function validateTelemetrySampleRate(value: unknown): number | undefined {
  if (value === undefined || value === null) {
    return 20;
  }
  if (!Number.isFinite(value) || (value as number) < 0 || (value as number) > 100) {
    display.error("Configuration error: 'telemetrySampleRate' must be a number between 0 and 100");
    return undefined;
  }
  return value as number;
}

const VALID_PRIVACY_LEVELS: readonly DefaultPrivacyLevel[] = [
  DefaultPrivacyLevel.MASK,
  DefaultPrivacyLevel.ALLOW,
  DefaultPrivacyLevel.MASK_USER_INPUT,
];

function validateDefaultPrivacyLevel(value: unknown): DefaultPrivacyLevel {
  if (value === undefined || value === null) {
    return DefaultPrivacyLevel.MASK;
  }
  if (typeof value !== 'string' || !(VALID_PRIVACY_LEVELS as readonly string[]).includes(value)) {
    display.error(`Configuration error: 'defaultPrivacyLevel' must be one of: ${VALID_PRIVACY_LEVELS.join(', ')}`);
    return DefaultPrivacyLevel.MASK;
  }
  return value as DefaultPrivacyLevel;
}

function validateAllowedRendererHosts(value: unknown): string[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    display.error(
      "Configuration error: 'allowedRendererHosts' must be an array of hostnames (e.g. ['example.com', 'myapp']), ['file://'] for file:// renderers, or ['*'] to allow all renderers including file://"
    );
    return [];
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
  const sessionSampleRate = validateSessionSampleRate(initConfig.sessionSampleRate);
  const profilingSampleRate = validateProfilingSampleRate(initConfig.profilingSampleRate);
  const telemetrySampleRate = validateTelemetrySampleRate(initConfig.telemetrySampleRate);

  if (sessionSampleRate === undefined || profilingSampleRate === undefined || telemetrySampleRate === undefined) {
    return undefined;
  }

  return {
    site,
    service,
    clientToken,
    applicationId,
    env: validateOptionalString(initConfig.env),
    version: validateOptionalString(initConfig.version),
    proxy,
    sessionSampleRate,
    profilingSampleRate,
    telemetrySampleRate,
    defaultPrivacyLevel: validateDefaultPrivacyLevel(initConfig.defaultPrivacyLevel),
    allowedRendererHosts: validateAllowedRendererHosts(initConfig.allowedRendererHosts),
  };
}
