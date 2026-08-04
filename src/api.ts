import { sanitize } from '@datadog/browser-core';
import { isIndexableObject } from '@datadog/js-core/util';
import type { Context, GlobalContext } from './domain/customer-context';
import type { AddDurationVitalOptions, DurationVitalOptions, RumCollection } from './domain/rum';
import { callMonitored } from './domain/telemetry';
import { display } from './tools/display';
import { isFiniteNumber, isValidString, VALID_VITAL_NAME_REGEX } from './tools/validation';

type DurationVitalMethod = 'addDurationVital' | 'startDurationVital' | 'stopDurationVital';
type DurationVitalApi = Pick<
  ReturnType<RumCollection['getApi']>,
  'addDurationVital' | 'startDurationVital' | 'stopDurationVital'
>;

type GlobalContextMethod =
  'setGlobalContext' | 'setGlobalContextProperty' | 'removeGlobalContextProperty' | 'clearGlobalContext';
type GlobalContextApi = Pick<
  GlobalContext,
  'getContext' | 'setContext' | 'setProperty' | 'removeProperty' | 'clearContext'
>;

let durationVitalApi: DurationVitalApi | undefined;
let globalContextApi: GlobalContextApi | undefined;

export function setDurationVitalApi(api: DurationVitalApi | undefined): void {
  durationVitalApi = api;
}

export function setGlobalContextApi(api: GlobalContextApi | undefined): void {
  globalContextApi = api;
}

/**
 * Replace the global context attached to all subsequent RUM events.
 * Renderer processes keep their own global context, set through the Browser SDK; on a conflicting
 * key the renderer's value wins.
 *
 * @example
 * ```ts
 * setGlobalContext({ team: 'checkout', build: '1.2.3' });
 * ```
 */
export function setGlobalContext(context: Record<string, unknown>): void {
  callMonitored(() => {
    if (!isIndexableObject(context)) {
      display.error('setGlobalContext: context must be an object. The context will not be updated.');
      return;
    }
    globalContextApi?.setContext(sanitize(context) as Context);
  });
}

/**
 * Return a copy of the current global context, or `{}` when none is set.
 *
 * @example
 * ```ts
 * const context = getGlobalContext(); // { team: 'checkout' }
 * ```
 */
export function getGlobalContext(): Record<string, unknown> {
  return globalContextApi?.getContext() ?? {};
}

/**
 * Set a single global context property, leaving the others untouched.
 * Passing `null` or `undefined` removes the property, matching `addUserExtraInfo`.
 *
 * @example
 * ```ts
 * setGlobalContextProperty('build', '1.2.3');
 * ```
 */
export function setGlobalContextProperty(key: string, value: unknown): void {
  callMonitored(() => {
    if (!validateContextKey('setGlobalContextProperty', key)) {
      return;
    }
    globalContextApi?.setProperty(key, sanitize(value));
  });
}

/**
 * Remove a single global context property.
 *
 * @example
 * ```ts
 * removeGlobalContextProperty('build');
 * ```
 */
export function removeGlobalContextProperty(key: string): void {
  callMonitored(() => {
    if (!validateContextKey('removeGlobalContextProperty', key)) {
      return;
    }
    globalContextApi?.removeProperty(key);
  });
}

/**
 * Clear the global context from all subsequent events.
 *
 * @example
 * ```ts
 * clearGlobalContext();
 * ```
 */
export function clearGlobalContext(): void {
  callMonitored(() => globalContextApi?.clearContext());
}

function validateContextKey(method: GlobalContextMethod, key: unknown): key is string {
  if (!isValidString(key)) {
    display.error(`${method}: key cannot be empty or blank. The context will not be updated.`);
    return false;
  }
  return true;
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
