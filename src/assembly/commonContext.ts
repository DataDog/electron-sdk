import type { Configuration } from '../config';
import type { FormatHooks } from './hooks';

/**
 * Define the common attributes for the events of each format
 */
export function registerCommonContext(configuration: Configuration, hooks: FormatHooks) {
  hooks.registerRum(() => ({
    date: Date.now(),
    source: 'electron',
    service: configuration.service,
    version: configuration.version,
    application: { id: configuration.applicationId },
    session: { type: 'user' },
    ddtags: `sdk_version:${__SDK_VERSION__}`,
    _dd: { format_version: 2 },
  }));

  hooks.registerTelemetry(() => ({
    date: Date.now(),
    source: 'electron',
    service: 'electron-sdk',
    version: __SDK_VERSION__,
    application: { id: configuration.applicationId },
    _dd: { format_version: 2 },
  }));
}
