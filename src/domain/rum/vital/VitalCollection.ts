import type { Duration, TimeStamp } from '@datadog/js-core/time';
import { elapsed, timeStampNow, toServerDuration } from '@datadog/js-core/time';
import { combine } from '@datadog/js-core/util';
import type { Context, Subscription } from '@datadog/browser-core';
import { generateUUID } from '@datadog/browser-core';
import { EventFormat, EventKind, EventManager, LifecycleKind, type SessionRenewEvent } from '../../../event';
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
    this.emit({
      id: generateUUID(),
      name,
      startTime: options.startTime as TimeStamp,
      duration: options.duration as Duration,
      options,
    });
  }

  private start(name: string, options?: DurationVitalOptions): void {
    const normalizedOptions = options ?? {};
    this.pendingVitals.set(normalizedOptions.vitalKey ?? name, {
      id: generateUUID(),
      name,
      startTime: timeStampNow(),
      options: normalizedOptions,
    });
  }

  private stopVital(name: string, options?: DurationVitalOptions): void {
    const normalizedOptions = options ?? {};
    const key = normalizedOptions.vitalKey ?? name;
    const pending = this.pendingVitals.get(key);
    if (!pending) {
      return;
    }

    this.pendingVitals.delete(key);
    const stopTime = timeStampNow();
    this.emit({
      ...pending,
      duration: elapsed(pending.startTime, stopTime),
      options: combine(pending.options, normalizedOptions),
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
