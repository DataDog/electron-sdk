import { jsonStringify } from '@datadog/browser-core';
import { RawTelemetryData } from './rawTelemetryData.types';

const MAX_TELEMETRY_EVENTS_PER_SESSION = 100;

/**
 * Per-session guardrails: deduplication and the event cap, reset together on session renewal.
 *
 * Identical events are dropped for the rest of the session: usage events would otherwise flood the
 * budget when an instrumented API is called in a loop, and repeated errors add no information.
 * Configuration events are exempt from the cap because there is at most one per process and it must
 * not be starved by a burst of errors (matches dd-sdk-android).
 */
export class SessionBudget {
  private eventCount = 0;
  private sentEventKeys = new Set<string>();

  /** Whether the event fits the budget. Accounts for it when it does, so calling twice is not idempotent. */
  accept(data: RawTelemetryData): boolean {
    const countsTowardCap = data.telemetry.type !== 'configuration';
    if (countsTowardCap && this.eventCount >= MAX_TELEMETRY_EVENTS_PER_SESSION) {
      return false;
    }

    const key = eventKey(data);
    if (key !== undefined) {
      if (this.sentEventKeys.has(key)) {
        return false;
      }
      this.sentEventKeys.add(key);
    }
    if (countsTowardCap) {
      this.eventCount++;
    }
    return true;
  }

  reset(): void {
    this.eventCount = 0;
    this.sentEventKeys.clear();
  }
}

/**
 * Deduplication key, or `undefined` when the event cannot be compared.
 *
 * `jsonStringify` never throws: it returns a fixed sentinel string when the value cannot be
 * serialized. Every telemetry payload the SDK builds is plain JSON, so that path is defensive —
 * treat a non-object result as not comparable and let the event through, rather than collapsing all
 * such events onto the one sentinel key.
 */
function eventKey(data: RawTelemetryData): string | undefined {
  const serialized = jsonStringify(data);
  return serialized?.startsWith('{') ? serialized : undefined;
}
