import type { Configuration } from '../config';
import { EventSource } from '../event';
import type { FormatHooks } from './hooks';
import { display } from '../tools/display';

/**
 * Define the common attributes for the events of each format
 */
export function registerCommonContext(configuration: Configuration, hooks: FormatHooks) {
  // Electron owns RUM session, replay, and profiling sampling for bridge events. Renderer tracing
  // remains controlled by the Browser SDK, so its trace sample rate must be preserved.
  const sharedSamplingConfiguration = {
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
          _dd: { configuration: sharedSamplingConfiguration },
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
          _dd: {
            format_version: 2,
            configuration: { ...sharedSamplingConfiguration, trace_sample_rate: configuration.traceSampleRate },
          },
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
