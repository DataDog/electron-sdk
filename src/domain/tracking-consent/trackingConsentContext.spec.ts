import { DISCARDED } from '@datadog/js-core/assembly';
import type { TimeStamp } from '@datadog/js-core/time';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFormatHooks } from '../../assembly';
import { EventSource } from '../../event';
import { registerTrackingConsentContext } from './trackingConsentContext';
import { createTrackingConsentState } from './trackingConsentState';

describe('registerTrackingConsentContext', () => {
  const T0 = 0 as TimeStamp;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('discards logs and telemetry while consent is not granted', () => {
    const hooks = createFormatHooks();
    const state = createTrackingConsentState('not-granted');
    registerTrackingConsentContext(hooks, state);

    expect(hooks.triggerLogs({ startTime: T0, source: EventSource.MAIN })).toBe(DISCARDED);
    expect(hooks.triggerTelemetry({ startTime: T0, source: EventSource.MAIN })).toBe(DISCARDED);
  });

  it('allows logs and telemetry after consent is granted', () => {
    const hooks = createFormatHooks();
    const state = createTrackingConsentState('not-granted');
    registerTrackingConsentContext(hooks, state);

    state.update('granted');

    expect(hooks.triggerLogs({ startTime: T0, source: EventSource.MAIN })).toBeUndefined();
    expect(hooks.triggerTelemetry({ startTime: T0, source: EventSource.MAIN })).toBeUndefined();
  });

  it('allows logs and telemetry while consent is pending', () => {
    const hooks = createFormatHooks();
    const state = createTrackingConsentState('pending');
    registerTrackingConsentContext(hooks, state);

    expect(hooks.triggerLogs({ startTime: T0, source: EventSource.MAIN })).toBeUndefined();
    expect(hooks.triggerTelemetry({ startTime: T0, source: EventSource.MAIN })).toBeUndefined();
  });

  it('does not move the collection boundary when pending consent is granted', () => {
    const hooks = createFormatHooks();
    const state = createTrackingConsentState('pending');
    registerTrackingConsentContext(hooks, state);

    vi.setSystemTime(10);
    state.update('granted');

    expect(hooks.triggerLogs({ startTime: T0, source: EventSource.RENDERER })).toBeUndefined();
  });

  it('does not accept an event captured before consent was granted', () => {
    const hooks = createFormatHooks();
    const state = createTrackingConsentState('not-granted');
    registerTrackingConsentContext(hooks, state);

    vi.setSystemTime(10);
    state.update('granted');

    expect(hooks.triggerLogs({ startTime: T0, source: EventSource.RENDERER })).toBe(DISCARDED);
    expect(hooks.triggerLogs({ startTime: 10 as TimeStamp, source: EventSource.RENDERER })).toBeUndefined();
  });

  it('does not move the grant boundary when granted consent is set again', () => {
    const hooks = createFormatHooks();
    const state = createTrackingConsentState('granted');
    registerTrackingConsentContext(hooks, state);

    vi.setSystemTime(10);
    state.update('granted');

    expect(hooks.triggerLogs({ startTime: T0, source: EventSource.RENDERER })).toBeUndefined();
  });

  it('leaves capture-time-gated formats to their session-aware contexts', () => {
    const hooks = createFormatHooks();
    const state = createTrackingConsentState('not-granted');
    registerTrackingConsentContext(hooks, state);

    expect(hooks.triggerRum({ eventType: 'view', startTime: T0, source: EventSource.MAIN })).toBeUndefined();
    expect(hooks.triggerSpan({ startTime: T0, source: EventSource.MAIN })).toBeUndefined();
  });
});
