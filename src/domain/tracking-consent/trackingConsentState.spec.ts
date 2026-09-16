import { describe, expect, it, vi } from 'vitest';
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
});
