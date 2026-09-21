import { describe, expect, it } from 'vitest';
import type { TimeStamp } from '@datadog/js-core/time';
import type { MainRumEvent } from '../domain/rum';
import { getRumConsentTime } from './rumConsentTime';

describe('getRumConsentTime', () => {
  it.each([
    [{ type: 'error', date: 1_000, freeze: { duration: 25_000_000 } }, 1_025],
    [{ type: 'resource', date: 1_000, resource: { duration: 30_000_000 } }, 1_030],
    [{ type: 'vital', date: 1_000, vital: { type: 'duration', duration: 40_000_000 } }, 1_040],
    [{ type: 'view', date: 1_000, view: { time_spent: 50_000_000 } }, 1_050],
  ])('uses the completion time of interval event %#', (event, expected) => {
    expect(getRumConsentTime(event as MainRumEvent, 2_000 as TimeStamp)).toBe(expected);
  });

  it('uses current processing time when a view has no valid time spent', () => {
    expect(getRumConsentTime({ type: 'view', date: 1_000, view: {} } as MainRumEvent, 2_000 as TimeStamp)).toBe(2_000);
    expect(getRumConsentTime({ type: 'view_update', date: 1_000 } as MainRumEvent, 2_000 as TimeStamp)).toBe(2_000);
  });

  it('does not turn instant events into intervals', () => {
    expect(getRumConsentTime({ type: 'error', date: 1_000 } as MainRumEvent, 2_000 as TimeStamp)).toBeUndefined();
  });
});
