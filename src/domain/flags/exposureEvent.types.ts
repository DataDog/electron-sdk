import type { TimeStamp } from '@datadog/js-core/time';

/**
 * Exposure event sent on the `exposures` track (D9). The payload is built with the
 * upstream `createExposureEvent` (allocation, flag, variant, subject and serial id),
 * enriched with the service and RUM application correlation fields the intake
 * requires.
 */
export interface FlagsExposureEvent {
  allocation: { key: string };
  flag: { key: string };
  variant: { key: string };
  subject: { id: string; attributes: Record<string, unknown> };
  serial_id?: number;
  service?: string;
  rum: {
    application: { id: string };
    view: { url: string };
  };
  timestamp: TimeStamp;
}
