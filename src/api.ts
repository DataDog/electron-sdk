import { objectEntries, sanitize } from '@datadog/browser-core';
import { isIndexableObject } from '@datadog/js-core/util';
import type { Context, GlobalContext } from './domain/customer-context';
import type { AddDurationVitalOptions, DurationVitalOptions, RumCollection } from './domain/rum';
import { VALID_TRACKING_CONSENTS } from './config';
import type { TrackingConsent, TrackingConsentManager } from './domain/tracking-consent';
import { addUsage, callMonitored } from './domain/telemetry';
import { display } from './tools/display';
import { isFiniteNumber, isOneOf, isValidString, VALID_VITAL_NAME_REGEX } from './tools/validation';

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

type TrackingConsentApi = Pick<TrackingConsentManager, 'update'>;

let durationVitalApi: DurationVitalApi | undefined;
let globalContextApi: GlobalContextApi | undefined;
let trackingConsentApi: TrackingConsentApi | undefined;

export function setDurationVitalApi(api: DurationVitalApi | undefined): void {
  durationVitalApi = api;
}

export function setGlobalContextApi(api: GlobalContextApi | undefined): void {
  globalContextApi = api;
}

export function setTrackingConsentApi(api: TrackingConsentApi): void {
  trackingConsentApi = api;
}

/**
 * Set the tracking consent of the end user. It applies to data collected from now on and to the
 * data kept while consent was pending:
 * - `'granted'`: data is collected and sent, including the data kept while consent was pending.
 * - `'pending'`: data is collected and kept on disk until the next decision, and deleted at the
 *   next launch if none was made.
 * - `'not-granted'`: no new data is kept or sent, and the data kept while consent was pending is
 *   deleted. Data stored earlier with consent is still sent. The session ends, and the next
 *   `'pending'` or `'granted'` starts a new one.
 *
 * The SDK does not restore the consent at the next launch: set `trackingConsent` in `init()` at
 * each launch, and call this method once `init()` has resolved: an earlier call can be ignored,
 * and is then reported as an error. An invalid value is handled as `'not-granted'`.
 *
 * @example
 * ```ts
 * await init({ ...configuration, trackingConsent: 'pending' });
 * // Once the end user has answered the consent prompt:
 * setTrackingConsent(accepted ? 'granted' : 'not-granted');
 * ```
 */
export function setTrackingConsent(consent: TrackingConsent): void {
  callMonitored(() => {
    if (!trackingConsentApi) {
      // Reported, unlike other APIs called before init(): under the 'granted' default, a lost refusal would go
      // unnoticed.
      display.error(
        'setTrackingConsent: called before init() resolved. This call is ignored: pass the consent known at startup with the trackingConsent option.'
      );
      return;
    }
    let trackingConsent = consent;
    if (!isOneOf(consent, VALID_TRACKING_CONSENTS)) {
      // Ignoring the call would keep collecting under a decision the app tried to change.
      display.error(
        `setTrackingConsent: consent must be one of: ${VALID_TRACKING_CONSENTS.join(', ')}. It is handled as not-granted.`
      );
      trackingConsent = 'not-granted';
    }
    trackingConsentApi.update(trackingConsent);
    // Reported after the update, so the event is stored under the consent it reports: a refusal is
    // not sent.
    addUsage({ feature: 'set-tracking-consent', tracking_consent: trackingConsent });
  });
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
    addUsage({ feature: 'set-global-context' });
    if (!isIndexableObject(context)) {
      display.error('setGlobalContext: context must be an object. The context will not be updated.');
      return;
    }
    const validContext: Context = {};
    for (const [key, value] of objectEntries(context)) {
      if (validateContextKey('setGlobalContext', key)) {
        validContext[key] = value;
      }
    }
    globalContextApi?.setContext(sanitize(validContext) as Context);
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
  return (
    callMonitored(() => {
      addUsage({ feature: 'get-global-context' });
      return globalContextApi?.getContext();
    }) ?? {}
  );
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
    addUsage({ feature: 'set-global-context-property' });
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
    addUsage({ feature: 'remove-global-context-property' });
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
  callMonitored(() => {
    addUsage({ feature: 'clear-global-context' });
    globalContextApi?.clearContext();
  });
}

function validateContextKey(method: GlobalContextMethod, key: unknown): key is string {
  if (!isValidString(key) || key !== key.trim()) {
    display.error(
      `${method}: key cannot be empty, blank, or have leading or trailing whitespace. The attribute will be ignored.`
    );
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
    addUsage({ feature: 'add-duration-vital' });
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
    addUsage({ feature: 'start-duration-vital' });
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
    addUsage({ feature: 'stop-duration-vital' });
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
