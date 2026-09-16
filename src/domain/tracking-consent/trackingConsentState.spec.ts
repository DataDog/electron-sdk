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

  it('runs collection-enabled callbacks for pending as well as granted', () => {
    const state = createTrackingConsentState('not-granted');
    const callback = vi.fn();
    state.onCollectionEnabledOnce(callback);

    state.update('pending');
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
});
