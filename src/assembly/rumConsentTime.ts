import type { TimeStamp } from '@datadog/js-core/time';
import type { MainRumEvent } from '../domain/rum';

/** Return the completion time for main-process RUM events whose payload covers an interval. */
export function getRumConsentTime(event: MainRumEvent, viewFallback: TimeStamp): TimeStamp | undefined {
  let duration: number | undefined;
  switch (event.type) {
    case 'resource':
      duration = event.resource.duration;
      break;
    case 'vital':
      if (event.vital.type === 'duration') duration = event.vital.duration;
      break;
    case 'view':
      duration = event.view.time_spent;
      break;
    case 'error':
      duration = event.freeze?.duration;
      break;
  }

  if (Number.isFinite(event.date) && duration !== undefined && Number.isFinite(duration) && duration >= 0) {
    return (event.date + duration / 1e6) as TimeStamp;
  }
  return event.type === 'view' || event.type === 'view_update' ? viewFallback : undefined;
}
