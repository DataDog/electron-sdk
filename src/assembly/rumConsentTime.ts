import type { TimeStamp } from '@datadog/js-core/time';
import { isIndexableObject } from '@datadog/js-core/util';

interface RumIntervalEvent {
  type: string;
  date: number;
  [key: string]: unknown;
}

/** Return the completion time for RUM events whose payload covers an interval. */
export function getRumConsentTime(event: RumIntervalEvent, viewFallback: TimeStamp): TimeStamp | undefined {
  if (event.type === 'transition') {
    return addMilliseconds(event.date, getNestedNumber(event, 'transition', 'duration'));
  }

  const serverDuration =
    event.type === 'action'
      ? getNestedNumber(event, 'action', 'loading_time')
      : event.type === 'long_task'
        ? getNestedNumber(event, 'long_task', 'duration')
        : event.type === 'error'
          ? getNestedNumber(event, 'freeze', 'duration')
          : event.type === 'resource'
            ? getNestedNumber(event, 'resource', 'duration')
            : event.type === 'view'
              ? getNestedNumber(event, 'view', 'time_spent')
              : event.type === 'vital' && getNestedValue(event, 'vital', 'type') === 'duration'
                ? getNestedNumber(event, 'vital', 'duration')
                : undefined;

  if (serverDuration !== undefined) {
    const completionTime = addMilliseconds(event.date, serverDuration / 1e6);
    if (completionTime !== undefined) {
      return completionTime;
    }
  }
  return event.type === 'view' || event.type === 'view_update' ? viewFallback : undefined;
}

function getNestedNumber(event: RumIntervalEvent, container: string, field: string): number | undefined {
  const value = getNestedValue(event, container, field);
  return typeof value === 'number' ? value : undefined;
}

function getNestedValue(event: RumIntervalEvent, container: string, field: string): unknown {
  const value = event[container];
  return isIndexableObject(value) ? value[field] : undefined;
}

function addMilliseconds(start: number, duration: number | undefined): TimeStamp | undefined {
  if (!Number.isFinite(start) || duration === undefined || !Number.isFinite(duration) || duration < 0) {
    return undefined;
  }
  return (start + duration) as TimeStamp;
}
