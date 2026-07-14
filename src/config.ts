import { validateAndBuildConfiguration } from '@datadog/js-core/configuration';
import type { ConfigurationSchema, InferredConfig } from '@datadog/js-core/configuration';
import { ONE_SECOND } from '@datadog/js-core/time';
import { ONE_KIBI_BYTE, ONE_MEBI_BYTE, DefaultPrivacyLevel } from '@datadog/browser-core';
import { display } from './tools/display';

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

export interface InitConfiguration {
  site: string;
  proxy?: string;
  service: string;
  clientToken: string;
  applicationId: string;
  env?: string;
  version?: string;
  sessionSampleRate?: number;
  telemetrySampleRate?: number;
  defaultPrivacyLevel?: DefaultPrivacyLevel;
  allowedWebViewHosts?: string[];
}

const CONFIG_SCHEMA = {
  site: { type: 'site', required: true },
  service: { type: 'string', required: true },
  clientToken: { type: 'string', required: true },
  applicationId: { type: 'string', required: true },
  env: { type: 'string' },
  version: { type: 'string' },
  proxy: { type: 'string' },
  sessionSampleRate: { type: 'percentage', default: 100 },
  telemetrySampleRate: { type: 'percentage', default: 20 },
  defaultPrivacyLevel: {
    type: 'enum',
    values: [DefaultPrivacyLevel.MASK, DefaultPrivacyLevel.ALLOW, DefaultPrivacyLevel.MASK_USER_INPUT],
    strict: false,
    default: DefaultPrivacyLevel.MASK,
  },
  allowedWebViewHosts: { type: 'string', multiple: true, strict: false, default: [] as string[] },
} as const satisfies ConfigurationSchema;

export type Configuration = InferredConfig<typeof CONFIG_SCHEMA>;

export function buildConfiguration(initConfig: InitConfiguration): Configuration | undefined {
  return validateAndBuildConfiguration(initConfig, CONFIG_SCHEMA, display);
}
