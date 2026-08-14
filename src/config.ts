import { ONE_SECOND } from '@datadog/js-core/time';
import { ONE_KIBI_BYTE, ONE_MEBI_BYTE, DefaultPrivacyLevel } from '@datadog/browser-core';
import { display } from './tools/display';
import { isFiniteNumber, isOneOf } from './tools/validation';

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

export type BatchSize = keyof typeof BatchSizes;
export type UploadFrequency = keyof typeof BatchUploadFrequencies;

const DEFAULT_BATCH_SIZE: BatchSize = 'MEDIUM';
const DEFAULT_UPLOAD_FREQUENCY: UploadFrequency = 'NORMAL';

export interface InitConfiguration {
  site: string;
  proxy?: string;
  service: string;
  clientToken: string;
  applicationId: string;
  env?: string;
  version?: string;
  sessionSampleRate?: number;
  sessionReplaySampleRate?: number;
  profilingSampleRate?: number;
  /**
   * Percentage of SDK instances that report telemetry (0–100), defaults to `20`. Drawn once at
   * `init()` and kept for the lifetime of the process, so an instance either reports telemetry for
   * its whole life or never does.
   * @example telemetrySampleRate: 100
   */
  telemetrySampleRate?: number;
  /**
   * Percentage of telemetry-enabled SDK instances that also report the resolved SDK configuration
   * (0–100), defaults to `20`. Applied as a child of {@link InitConfiguration.telemetrySampleRate}:
   * the effective rate is the product of the two, so the default pair reports from 4% of instances.
   * Drawn once at `init()`.
   * @example telemetryConfigurationSampleRate: 100
   */
  telemetryConfigurationSampleRate?: number;
  /**
   * Percentage of telemetry-enabled SDK instances that also report which public APIs the app calls
   * (0–100), defaults to `20`. Applied as a child of {@link InitConfiguration.telemetrySampleRate}:
   * the effective rate is the product of the two, so the default pair reports from 4% of instances.
   * Drawn once at `init()`.
   * @example telemetryUsageSampleRate: 100
   */
  telemetryUsageSampleRate?: number;
  batchSize?: BatchSize;
  uploadFrequency?: UploadFrequency;
  defaultPrivacyLevel?: DefaultPrivacyLevel;
  /**
   * Hostnames allowed to send bridge events to the main process. Supports exact hostnames,
   * subdomain suffixes, single-wildcard globs, `'file://'` for local files, and `'*'` for all.
   * @example ['app.example.com', '*.staging.example.com', 'file://', '*']
   */
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
  sessionReplaySampleRate: number;
  profilingSampleRate: number;
  telemetrySampleRate: number;
  telemetryConfigurationSampleRate: number;
  telemetryUsageSampleRate: number;
  batchSize: BatchSize;
  uploadFrequency: UploadFrequency;
  defaultPrivacyLevel: DefaultPrivacyLevel;
  allowedRendererHosts: string[];
}

/**
 * Batch byte threshold the resolved `batchSize` stands for.
 *
 * Caps how large a single batch file may grow before it is rotated early; the batch window itself is
 * driven by {@link resolveUploadFrequency}. Configuration telemetry deliberately does not report this
 * — the schema's `batch_size` is a window duration in milliseconds, not a byte count; see
 * `buildConfigurationTelemetry`.
 */
export function resolveBatchSize(configuration: Configuration): number {
  return BatchSizes[configuration.batchSize];
}

/**
 * Upload period in milliseconds the resolved `uploadFrequency` stands for.
 *
 * Doubles as the batch window: each upload cycle seals the open batch and drains every pending one,
 * so events accumulate for exactly this long. Shared by the transport and configuration telemetry so
 * both report the same value.
 */
export function resolveUploadFrequency(configuration: Configuration): number {
  return BatchUploadFrequencies[configuration.uploadFrequency];
}

function validateRequiredString(value: unknown, fieldName: string): string | undefined {
  if (typeof value !== 'string' || value.length === 0) {
    display.error(`Configuration error: '${fieldName}' must be a non-empty string`);
    return undefined;
  }
  return value;
}

function validateSite(value: unknown): string | undefined {
  if (!isOneOf(value, VALID_DATADOG_SITES)) {
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

/**
 * Validate a 0–100 percentage. Returns `defaultValue` when unset, or `undefined` on an invalid
 * value to signal that initialization should abort.
 */
function validateSampleRate(value: unknown, fieldName: string, defaultValue: number): number | undefined {
  if (value === undefined || value === null) {
    return defaultValue;
  }
  if (!isFiniteNumber(value) || value < 0 || value > 100) {
    display.error(`Configuration error: '${fieldName}' must be a number between 0 and 100`);
    return undefined;
  }
  return value;
}

/**
 * Validate an option whose value must be one of a fixed set of strings, resolving it to
 * `defaultValue` when unset.
 *
 * An invalid value is reported and falls back to the default rather than aborting `init()`.
 */
function validateEnumOption<T extends string>(
  value: unknown,
  fieldName: string,
  allowedValues: readonly T[],
  defaultValue: T
): T {
  if (value === undefined || value === null) {
    return defaultValue;
  }
  if (!isOneOf(value, allowedValues)) {
    display.error(`Configuration error: '${fieldName}' must be one of: ${allowedValues.join(', ')}`);
    return defaultValue;
  }
  return value;
}

const VALID_BATCH_SIZES = Object.keys(BatchSizes) as BatchSize[];
const VALID_UPLOAD_FREQUENCIES = Object.keys(BatchUploadFrequencies) as UploadFrequency[];

const VALID_PRIVACY_LEVELS: readonly DefaultPrivacyLevel[] = [
  DefaultPrivacyLevel.MASK,
  DefaultPrivacyLevel.ALLOW,
  DefaultPrivacyLevel.MASK_USER_INPUT,
];

function validateAllowedRendererHosts(value: unknown): string[] | undefined {
  if (
    value === undefined ||
    value === null ||
    !Array.isArray(value) ||
    !value.every((item) => typeof item === 'string')
  ) {
    display.error(
      "Configuration error: 'allowedRendererHosts' must be an array of hostnames (e.g. ['example.com', 'myapp']), ['file://'] for file:// renderers, or ['*'] to allow all renderers including file://"
    );
    return undefined;
  }
  return value.flatMap((host) => {
    if (host === '*') return ['*', ''];
    if (host === 'file://') return [''];
    if (host === '') {
      display.error(
        `Configuration error: 'allowedRendererHosts' entry '${host}' is invalid and will be ignored (empty string)`
      );
      return [];
    }
    // Reject entries that contain URL-syntax characters that would cause the URL constructor
    // to silently extract a different host (e.g. 'foo@evil.com' → 'evil.com', 'host:8443' → 'host').
    // Also reject trailing dots: 'com.' has a dot, bypassing the single-label guard, and Node.js
    // does not normalize trailing dots in URL.hostname, so 'attacker.com.' would match '.com.'.
    if (/[@/:?#\s]/.test(host) || host.endsWith('.')) {
      display.error(
        `Configuration error: 'allowedRendererHosts' entry '${host}' is not a valid hostname and will be ignored`
      );
      return [];
    }
    // Only ASCII hostnames are supported. For internationalized domain names, provide the
    // ASCII-compatible encoding (punycode) directly (e.g. 'bücher.example' → 'xn--bcher-kva.example').
    if (/[-￿]/.test(host)) {
      display.error(
        `Configuration error: 'allowedRendererHosts' entry '${host}' is not a valid hostname and will be ignored (non-ASCII hostnames are not supported; use the ASCII-compatible encoding)`
      );
      return [];
    }
    const wildcardCount = (host.match(/\*/g) ?? []).length;
    if (wildcardCount > 1) {
      display.error(
        `Configuration error: 'allowedRendererHosts' entry '${host}' is invalid and will be ignored (multiple wildcards)`
      );
      return [];
    }
    if (wildcardCount === 1) {
      const suffix = host.slice(host.indexOf('*') + 1);
      // Best-effort check: the wildcard must be immediately followed by '.' and the suffix must
      // contain at least two domain labels (e.g. '.example.com') to reject obvious broad patterns
      // like '*.com'. Country-code second-level domains such as '*.co.uk' pass this check by
      // design — full public-suffix-list validation would require an additional dependency.
      if (!suffix.startsWith('.') || suffix.split('.').length < 3) {
        display.error(
          `Configuration error: 'allowedRendererHosts' entry '${host}' is invalid and will be ignored (wildcard must match subdomains of a full domain, e.g. '*.example.com')`
        );
        return [];
      }
    }
    return [host];
  });
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
  const sessionSampleRate = validateSampleRate(initConfig.sessionSampleRate, 'sessionSampleRate', 100);
  const sessionReplaySampleRate = validateSampleRate(initConfig.sessionReplaySampleRate, 'sessionReplaySampleRate', 0);
  const profilingSampleRate = validateSampleRate(initConfig.profilingSampleRate, 'profilingSampleRate', 0);
  const telemetrySampleRate = validateSampleRate(initConfig.telemetrySampleRate, 'telemetrySampleRate', 20);
  const telemetryConfigurationSampleRate = validateSampleRate(
    initConfig.telemetryConfigurationSampleRate,
    'telemetryConfigurationSampleRate',
    20
  );
  const telemetryUsageSampleRate = validateSampleRate(
    initConfig.telemetryUsageSampleRate,
    'telemetryUsageSampleRate',
    20
  );

  if (
    sessionSampleRate === undefined ||
    sessionReplaySampleRate === undefined ||
    profilingSampleRate === undefined ||
    telemetrySampleRate === undefined ||
    telemetryConfigurationSampleRate === undefined ||
    telemetryUsageSampleRate === undefined
  ) {
    return undefined;
  }

  const allowedRendererHosts = validateAllowedRendererHosts(initConfig.allowedRendererHosts);
  if (allowedRendererHosts === undefined) {
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
    sessionReplaySampleRate,
    profilingSampleRate,
    telemetrySampleRate,
    telemetryConfigurationSampleRate,
    telemetryUsageSampleRate,
    batchSize: validateEnumOption(initConfig.batchSize, 'batchSize', VALID_BATCH_SIZES, DEFAULT_BATCH_SIZE),
    uploadFrequency: validateEnumOption(
      initConfig.uploadFrequency,
      'uploadFrequency',
      VALID_UPLOAD_FREQUENCIES,
      DEFAULT_UPLOAD_FREQUENCY
    ),
    defaultPrivacyLevel: validateEnumOption(
      initConfig.defaultPrivacyLevel,
      'defaultPrivacyLevel',
      VALID_PRIVACY_LEVELS,
      DefaultPrivacyLevel.MASK
    ),
    allowedRendererHosts,
  };
}
