import { SKIPPED } from '@datadog/js-core/assembly';
import type { Configuration } from '../config';
import { EventSource } from '../event';
import type { FormatHooks } from './hooks';
import { display } from '../tools/display';

/**
 * Define the common attributes for the events of each format
 */
export function registerCommonContext(configuration: Configuration, hooks: FormatHooks) {
  // The Electron SDK owns the sampling decisions (including for renderer bridge events in bridge mode),
  // so it is authoritative for the rates reported on every RUM event.
  const ddConfiguration = {
    session_sample_rate: configuration.sessionSampleRate,
    session_replay_sample_rate: configuration.sessionReplaySampleRate,
    profiling_sample_rate: configuration.profilingSampleRate,
  };

  hooks.registerRum(({ source }) => {
    switch (source) {
      case EventSource.RENDERER:
        return {
          application: { id: configuration.applicationId },
          container: { source: 'electron' },
          _dd: { configuration: ddConfiguration },
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
          _dd: { format_version: 2, configuration: ddConfiguration },
        };
    }
  });

  hooks.registerTelemetry(({ source }) => {
    switch (source) {
      // Renderer telemetry already identifies the browser SDK that assembled it.
      case EventSource.RENDERER:
        return { application: { id: configuration.applicationId } };
      case EventSource.MAIN:
        return {
          date: Date.now(),
          source: 'electron',
          service: 'electron-sdk',
          version: __SDK_VERSION__,
          application: { id: configuration.applicationId },
          ddtags: buildDdtags(configuration),
          _dd: { format_version: 2 },
        };
    }
  });

  hooks.registerLogs(({ source }) => {
    switch (source) {
      // A renderer log crosses the bridge already assembled by the browser Logs SDK, and it belongs to
      // the renderer that produced it: its `service`, `ddtags` and `status` are the ones its own
      // `DD_LOGS.init()` configured, so restamping them here would relabel the customer's own logs. The
      // application is the only one of these the main process owns.
      case EventSource.RENDERER:
        return { application_id: configuration.applicationId };
      // The SDK has no main-process logging API yet (RUM-15047); when it gains one, its identity fields
      // belong here, next to the RUM and telemetry cases above.
      case EventSource.MAIN:
        return SKIPPED;
    }
  });

  hooks.registerSpan(() => ({
    meta: {
      '_dd.application.id': configuration.applicationId,
    },
  }));
}

function buildDdtags(configuration: Configuration): string {
  const tags = [buildTag('sdk_version', __SDK_VERSION__), buildTag('service', configuration.service)];
  if (configuration.env) tags.push(buildTag('env', configuration.env));
  if (configuration.version) tags.push(buildTag('version', configuration.version));
  return tags.join(',');
}

const TAG_SIZE_LIMIT = 200;

function buildTag(key: string, value: string): string {
  const tag = `${key}:${value}`;
  const sanitized = sanitizeTag(tag);
  if (tag.length > TAG_SIZE_LIMIT || hasForbiddenTagCharacters(sanitized)) {
    display.warn(
      `Tag "${tag}" doesn't meet tag requirements and will be sanitized. See https://docs.datadoghq.com/getting_started/tagging/#defining-tags`
    );
  }
  return sanitized;
}

// Commas delimit tags in the ddtags string, so any comma in a value would corrupt the list.
// Other invalid characters and oversized tags are forwarded to the backend for sanitization.
function sanitizeTag(tag: string): string {
  return tag.replace(/,/g, '_');
}

function hasForbiddenTagCharacters(tag: string): boolean {
  // We use the Unicode property escapes to match any character that is a letter including other languages like Chinese, Japanese, etc.
  // p{Ll} matches a lowercase letter.
  // p{Lo} matches a letter that is neither uppercase nor lowercase (ex: Japanese characters).
  // See https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Regular_expressions/Unicode_character_class_escape#unicode_property_escapes_vs._character_classes
  return /[^\p{Ll}\p{Lo}0-9_:./-]/u.test(tag);
}
