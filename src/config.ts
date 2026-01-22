import { computeIntakeUrl } from './transport/http';

export interface InitConfiguration {
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
  if (typeof value !== 'string') {
    console.error(`Configuration error: '${fieldName}' must be a string, received: ${typeof value}`);
    return undefined;
  }

  if (value.length === 0) {
    console.error(`Configuration error: '${fieldName}' must not be empty`);
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

  if (service === undefined || clientToken === undefined) {
    return undefined;
  }

  const env = validateOptionalString(initConfig.env);
  const version = validateOptionalString(initConfig.version);
  const intakeUrl = computeIntakeUrl(validateOptionalString(initConfig.proxy));

  return {
    service,
    clientToken,
    env,
    version,
    intakeUrl,
  };
}
