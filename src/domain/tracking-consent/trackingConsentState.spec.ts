import { describe, expect, it, vi } from 'vitest';
import type { TimeStamp } from '@datadog/js-core/time';
import { createTrackingConsentState } from './trackingConsentState';

describe('createTrackingConsentState', () => {
  it('keeps a value set before initialization', () => {
    const state = createTrackingConsentState();
    state.update('pending');
    state.tryToInit('not-granted');

    expect(state.get()).toBe('pending');
    expect(state.isCollectionEnabled()).toBe(true);
  });

  it('reports transitions and ignores updates to the current value', () => {
    const state = createTrackingConsentState('pending');
    const observer = vi.fn();
    state.observable.subscribe(observer);

    state.update('pending');
    state.update('granted');

    expect(observer).toHaveBeenCalledOnce();
    expect(observer).toHaveBeenCalledWith({ previous: 'pending', current: 'granted' });
  });

  it('keeps authorization callbacks armed when a reported pending interval is rejected', () => {
    const state = createTrackingConsentState('not-granted');
    const callback = vi.fn();
    state.onCollectionAuthorizedOnce(callback);

    state.update('pending');
    state.update('not-granted');
    state.update('granted');

    expect(callback).toHaveBeenCalledTimes(2);
  });

  it('does not report again when the pending interval is granted', () => {
    const state = createTrackingConsentState('pending');
    const callback = vi.fn();
    state.onCollectionAuthorizedOnce(callback);

    state.update('granted');

    expect(callback).toHaveBeenCalledOnce();
  });

  it('notifies storage observers before lifecycle observers', () => {
    const state = createTrackingConsentState('not-granted');
    const calls: string[] = [];
    state.beforeObservable.subscribe(() => calls.push('storage'));
    state.observable.subscribe(() => calls.push('lifecycle'));

    state.update('pending');

    expect(calls).toEqual(['storage', 'lifecycle']);
  });

  it('notifies boundary observers while the previous consent is still active', () => {
    const state = createTrackingConsentState('granted');
    const observedStates: (string | undefined)[] = [];
    state.boundaryObservable.subscribe(() => observedStates.push(state.get()));

    state.update('pending');

    expect(observedStates).toEqual(['granted']);
    expect(state.get()).toBe('pending');
  });

  it('serializes consent updates triggered by boundary observers', () => {
    const state = createTrackingConsentState('granted');
    const transitions: string[] = [];
    state.boundaryObservable.subscribe((change) => {
      if (change.current === 'pending') {
        state.update('not-granted');
      }
    });
    state.observable.subscribe(({ current }) => transitions.push(current));

    state.update('pending');

    expect(transitions).toEqual(['pending', 'not-granted']);
    expect(state.get()).toBe('not-granted');
  });

  it('ignores a reentrant request for the transition already in progress', () => {
    const state = createTrackingConsentState('granted');
    const observer = vi.fn();
    state.boundaryObservable.subscribe(({ current }) => state.update(current));
    state.observable.subscribe(observer);

    state.update('pending');

    expect(observer).toHaveBeenCalledOnce();
    expect(state.get()).toBe('pending');
  });

  it('resolves pending capture intervals from the decision that followed them', () => {
    vi.useFakeTimers();
    vi.setSystemTime(10);
    const grantedState = createTrackingConsentState('pending');
    const rejectedState = createTrackingConsentState('pending');

    vi.setSystemTime(20);
    grantedState.update('granted');
    rejectedState.update('not-granted');

    expect(grantedState.resolveForStorage(15 as TimeStamp)).toBe('granted');
    expect(rejectedState.resolveForStorage(15 as TimeStamp)).toBe('not-granted');
    vi.useRealTimers();
  });

  it('keeps admission decisions distinct across transitions within the same millisecond', () => {
    vi.useFakeTimers();
    vi.setSystemTime(10);
    const state = createTrackingConsentState();
    const uninitialized = state.captureStorageConsent();
    state.tryToInit('pending');
    const rejected = state.captureStorageConsent();
    state.update('not-granted');
    const denied = state.captureStorageConsent();
    state.update('pending');
    const authorized = state.captureStorageConsent();
    expect(authorized()).toBe('pending');
    state.update('granted');
    const granted = state.captureStorageConsent();
    state.update('not-granted');

    expect(uninitialized()).toBeUndefined();
    expect(rejected()).toBe('not-granted');
    expect(denied()).toBe('not-granted');
    expect(authorized()).toBe('granted');
    expect(granted()).toBe('granted');
    vi.useRealTimers();
  });

  it('resolves every consent state crossed by a completed interval', () => {
    vi.useFakeTimers();
    vi.setSystemTime(10);
    const state = createTrackingConsentState('granted');

    vi.setSystemTime(20);
    state.update('pending');
    expect(state.resolveForStorageInterval(15 as TimeStamp, 25 as TimeStamp)).toBe('pending');

    vi.setSystemTime(30);
    state.update('not-granted');
    vi.setSystemTime(40);
    state.update('granted');

    expect(state.resolveForStorageInterval(15 as TimeStamp, 45 as TimeStamp)).toBe('not-granted');
    expect(state.resolveForStorageInterval(40 as TimeStamp, 45 as TimeStamp)).toBe('granted');
    vi.useRealTimers();
  });
});
