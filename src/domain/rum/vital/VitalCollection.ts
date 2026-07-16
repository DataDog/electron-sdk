import type { Duration, TimeStamp } from '@datadog/js-core/time';
import { elapsed, timeStampNow, toServerDuration } from '@datadog/js-core/time';
import { combine, isIndexableObject } from '@datadog/js-core/util';
import type { Context, Subscription } from '@datadog/browser-core';
import { generateUUID, sanitize } from '@datadog/browser-core';
import { EventFormat, EventKind, EventManager, LifecycleKind, type SessionRenewEvent } from '../../../event';
import { display } from '../../../tools/display';
import type { RawRumDurationVital } from '../rawRumData.types';

/** Options accepted by duration-vital start and stop calls. */
export interface DurationVitalOptions {
  /** Distinguishes concurrent duration vitals sharing the same name. */
  vitalKey?: string;

  /** Custom attributes merged into the emitted event context. */
  context?: Context;

  /** Free-form description attached to `vital.description`. */
  description?: string;
}

/** Options accepted when adding an already-completed duration vital. */
export interface AddDurationVitalOptions extends DurationVitalOptions {
  /** UNIX timestamp in milliseconds at which the vital started. */
  startTime: number;

  /** Duration in milliseconds. */
  duration: number;
}

interface PendingDurationVital {
  id: string;
  name: string;
  startTime: TimeStamp;
  options: DurationVitalOptions;
}

type DurationVitalMethod = 'addDurationVital' | 'startDurationVital' | 'stopDurationVital';

/** Collect custom duration-vital events emitted from the main process. */
export class VitalCollection {
  private readonly pendingVitals = new Map<string, PendingDurationVital>();
  private readonly sessionRenewSubscription: Subscription;

  constructor(private readonly eventManager: EventManager) {
    this.sessionRenewSubscription = eventManager.registerHandler<SessionRenewEvent>({
      canHandle: (event): event is SessionRenewEvent =>
        event.kind === EventKind.LIFECYCLE && event.lifecycle === LifecycleKind.SESSION_RENEW,
      handle: () => this.pendingVitals.clear(),
    });
  }

  getApi() {
    return {
      addDurationVital: (name: string, options: AddDurationVitalOptions) => this.add(name, options),
      startDurationVital: (name: string, options?: DurationVitalOptions) => this.start(name, options),
      stopDurationVital: (name: string, options?: DurationVitalOptions) => this.stopVital(name, options),
    };
  }

  stop(): void {
    this.pendingVitals.clear();
    this.sessionRenewSubscription.unsubscribe();
  }

  private add(name: string, options: AddDurationVitalOptions): void {
    if (!validateArgs('addDurationVital', name, options, true)) {
      return;
    }

    this.emit({
      id: generateUUID(),
      name,
      startTime: options.startTime as TimeStamp,
      duration: options.duration as Duration,
      options: sanitizeOptions(options),
    });
  }

  private start(name: string, options?: DurationVitalOptions): void {
    if (!validateArgs('startDurationVital', name, options, false)) {
      return;
    }

    const sanitizedOptions = sanitizeOptions(options);
    this.pendingVitals.set(sanitizedOptions.vitalKey ?? name, {
      id: generateUUID(),
      name,
      startTime: timeStampNow(),
      options: sanitizedOptions,
    });
  }

  private stopVital(name: string, options?: DurationVitalOptions): void {
    if (!validateArgs('stopDurationVital', name, options, false)) {
      return;
    }

    const sanitizedOptions = sanitizeOptions(options);
    const key = sanitizedOptions.vitalKey ?? name;
    const pending = this.pendingVitals.get(key);
    if (!pending) {
      return;
    }

    this.pendingVitals.delete(key);
    const stopTime = timeStampNow();
    this.emit({
      ...pending,
      duration: elapsed(pending.startTime, stopTime),
      options: combine(pending.options, sanitizedOptions),
    });
  }

  private emit(vital: PendingDurationVital & { duration: Duration }): void {
    const data: RawRumDurationVital = {
      type: 'vital',
      date: vital.startTime,
      context: vital.options.context,
      vital: {
        id: vital.id,
        name: vital.name,
        type: 'duration',
        duration: toServerDuration(vital.duration),
        ...(vital.options.description === undefined ? {} : { description: vital.options.description }),
      },
    };

    this.eventManager.notify({
      kind: EventKind.RAW,
      format: EventFormat.RUM,
      data,
      startTime: vital.startTime,
    });
  }
}

function sanitizeOptions(options?: DurationVitalOptions): DurationVitalOptions {
  if (!options) {
    return {};
  }
  return {
    vitalKey: options.vitalKey,
    context: options.context === undefined ? undefined : sanitize(options.context),
    description: options.description === undefined ? undefined : sanitize(options.description),
  };
}

function validateArgs(
  method: DurationVitalMethod,
  name: unknown,
  options: unknown,
  requireTiming: boolean
): options is AddDurationVitalOptions | DurationVitalOptions | undefined {
  if (typeof name !== 'string' || name.trim().length === 0) {
    display.error(`${method}: vital name cannot be empty or blank. Event will not be sent.`);
    return false;
  }
  if (!VALID_VITAL_NAME_REGEX.test(name)) {
    display.warn(
      `${method}: vital name '${name}' does not match the backend-accepted pattern [\\w.@$-]* (letters, digits, _ . @ $ -). The event will still be sent and may be rejected by the backend.`
    );
  }
  if (options === undefined) {
    if (requireTiming) {
      display.error(`${method}: options must be an object. Event will not be sent.`);
      return false;
    }
    return true;
  }
  if (!isIndexableObject(options)) {
    display.error(`${method}: options must be an object. Event will not be sent.`);
    return false;
  }
  if (
    options.vitalKey !== undefined &&
    (typeof options.vitalKey !== 'string' || options.vitalKey.trim().length === 0)
  ) {
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
  if (requireTiming && (!isFiniteNumber(options.startTime) || !isFiniteNumber(options.duration))) {
    display.error(`${method}: startTime and duration must be finite numbers. Event will not be sent.`);
    return false;
  }
  return true;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

const VALID_VITAL_NAME_REGEX = /^[\w.@$-]*$/;
