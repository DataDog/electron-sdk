import { sanitize } from '@datadog/browser-core';
import { isIndexableObject } from '@datadog/js-core/util';
import type { AddDurationVitalOptions, DurationVitalOptions, RumCollection } from './domain/rum';
import { callMonitored } from './domain/telemetry';
import { display } from './tools/display';
import { isFiniteNumber, isValidString, VALID_VITAL_NAME_REGEX } from './tools/validation';

type DurationVitalMethod = 'addDurationVital' | 'startDurationVital' | 'stopDurationVital';
type DurationVitalApi = Pick<
  ReturnType<RumCollection['getApi']>,
  'addDurationVital' | 'startDurationVital' | 'stopDurationVital'
>;

let durationVitalApi: DurationVitalApi | undefined;

export function setDurationVitalApi(api: DurationVitalApi | undefined): void {
  durationVitalApi = api;
}

/**
 * Add an already-completed custom duration vital.
 *
 * `startTime` is a UNIX timestamp in milliseconds and `duration` is expressed in milliseconds.
 *
 * @example
 * ```ts
 * addDurationVital('database.migration', {
 *   startTime: Date.now() - 1_500,
 *   duration: 1_500,
 *   context: { migration: 'users' },
 * });
 * ```
 */
export function addDurationVital(name: string, options: AddDurationVitalOptions): void {
  callMonitored(() => {
    if (!validateDurationVitalArgs('addDurationVital', name, options, true)) {
      return;
    }
    const sanitizedOptions = sanitizeDurationVitalOptions(options);
    durationVitalApi?.addDurationVital(name, {
      ...sanitizedOptions,
      startTime: options.startTime,
      duration: options.duration,
    });
  });
}

/**
 * Start measuring a custom duration vital.
 *
 * Use `vitalKey` when multiple instances with the same name can overlap. The matching stop call must happen in the
 * same Electron process.
 *
 * @example
 * ```ts
 * startDurationVital('document.open', { vitalKey: documentId });
 * await openDocument(documentId);
 * stopDurationVital('document.open', { vitalKey: documentId });
 * ```
 */
export function startDurationVital(name: string, options?: DurationVitalOptions): void {
  callMonitored(() => {
    if (!validateDurationVitalArgs('startDurationVital', name, options, false)) {
      return;
    }
    const sanitizedOptions = sanitizeDurationVitalOptions(options);
    durationVitalApi?.startDurationVital(name, sanitizedOptions);
  });
}

/**
 * Stop a custom duration vital started with `startDurationVital`.
 *
 * Context and description supplied here are merged with the start options.
 *
 * @example
 * ```ts
 * startDurationVital('cache.warmup');
 * await warmCache();
 * stopDurationVital('cache.warmup', { context: { entries: 42 } });
 * ```
 */
export function stopDurationVital(name: string, options?: DurationVitalOptions): void {
  callMonitored(() => {
    if (!validateDurationVitalArgs('stopDurationVital', name, options, false)) {
      return;
    }
    const sanitizedOptions = sanitizeDurationVitalOptions(options);
    durationVitalApi?.stopDurationVital(name, sanitizedOptions);
  });
}

function sanitizeDurationVitalOptions(options?: DurationVitalOptions): DurationVitalOptions {
  if (!options) {
    return {};
  }
  return {
    vitalKey: options.vitalKey,
    context: options.context === undefined ? undefined : sanitize(options.context),
    description: options.description === undefined ? undefined : sanitize(options.description),
  };
}

function validateDurationVitalArgs(
  method: DurationVitalMethod,
  name: unknown,
  options: unknown,
  requireDuration: boolean
): options is AddDurationVitalOptions | DurationVitalOptions | undefined {
  if (!isValidString(name)) {
    display.error(`${method}: vital name cannot be empty or blank. Event will not be sent.`);
    return false;
  }
  if (!VALID_VITAL_NAME_REGEX.test(name)) {
    display.warn(
      `${method}: vital name '${name}' does not match the backend-accepted pattern [\\w.@$-]* (letters, digits, _ . @ $ -). The event will still be sent and may be rejected by the backend.`
    );
  }
  if (requireDuration) {
    if (!validateDurationOptions(method, options)) {
      return false;
    }
  } else {
    if (options === undefined) {
      return true;
    }
    if (!isIndexableObject(options)) {
      display.error(`${method}: options must be an object. Event will not be sent.`);
      return false;
    }
  }
  if (options.vitalKey !== undefined && !isValidString(options.vitalKey)) {
    display.error(`${method}: vital key cannot be empty or blank. Event will not be sent.`);
    return false;
  }
  if (options.context !== undefined && !isIndexableObject(options.context)) {
    display.error(`${method}: context must be an object when provided. Event will not be sent.`);
    return false;
  }
  if (options.description !== undefined && typeof options.description !== 'string') {
    display.error(`${method}: description must be a string when provided. Event will not be sent.`);
    return false;
  }
  return true;
}

function validateDurationOptions(
  method: DurationVitalMethod,
  options: unknown
): options is Record<string, unknown> & { startTime: number; duration: number } {
  if (!isIndexableObject(options)) {
    display.error(`${method}: options must be an object. Event will not be sent.`);
    return false;
  }
  if (!isFiniteNumber(options.startTime) || !isFiniteNumber(options.duration)) {
    display.error(`${method}: startTime and duration must be finite numbers. Event will not be sent.`);
    return false;
  }
  return true;
}
