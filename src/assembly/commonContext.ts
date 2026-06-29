import type { Configuration } from '../config';
import { EventSource } from '../event';
import type { FormatHooks } from './hooks';

/**
 * Define the common attributes for the events of each format
 */
export function registerCommonContext(configuration: Configuration, hooks: FormatHooks) {
  hooks.registerRum(({ source }) => {
    switch (source) {
      case EventSource.RENDERER:
        return {
          application: { id: configuration.applicationId },
          container: { source: 'electron' },
        };
      case EventSource.MAIN:
        return {
          date: Date.now(),
          source: 'electron',
          service: configuration.service,
          version: configuration.version,
          application: { id: configuration.applicationId },
          session: { type: 'user' },
          ddtags: buildDdtags(configuration),
          _dd: { format_version: 2 },
        };
    }
  });

  hooks.registerTelemetry(() => ({
    date: Date.now(),
    source: 'electron',
    service: 'electron-sdk',
    version: __SDK_VERSION__,
    application: { id: configuration.applicationId },
    _dd: { format_version: 2 },
  }));

  hooks.registerSpan(() => ({
    meta: {
      '_dd.application.id': configuration.applicationId,
    },
  }));
}

function buildDdtags(configuration: Configuration): string {
  const tags = [`sdk_version:${__SDK_VERSION__}`, `service:${configuration.service}`];
  if (configuration.env) tags.push(`env:${configuration.env}`);
  if (configuration.version) tags.push(`version:${configuration.version}`);
  return tags.join(',');
}
