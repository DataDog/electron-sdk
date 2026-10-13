import { describe, it, expect } from 'vitest';
import { FlagsState } from './FlagsState';
import type { FlagsSnapshot, FlatContext } from '../../common/flags/types';

const anonymousContext: FlatContext = { targetingKey: 'anonymous-key' };

describe('FlagsState', () => {
  it('starts NOT_READY with the anonymous context', () => {
    const state = new FlagsState(anonymousContext);
    expect(state.snapshot()).toEqual({
      revision: 0,
      status: 'NOT_READY',
      context: anonymousContext,
      contextRevision: 0,
      configurationRevision: 0,
      tracking: { exposures: true, rum: true, evaluations: true },
    });
    expect(state.getContext(0)).toEqual(anonymousContext);
  });

  it('configuration and context changes bump their own revision and the snapshot revision', () => {
    const state = new FlagsState(anonymousContext);
    state.applyConfigurationUpdate({ configuration: 'wire-1', status: 'READY' });
    expect(state.snapshot().configurationRevision).toBe(1);
    expect(state.snapshot().revision).toBe(1);
    state.applyContextUpdate({ targetingKey: 'user-1' });
    expect(state.snapshot().contextRevision).toBe(1);
    expect(state.snapshot().revision).toBe(2);
    expect(state.snapshot().context).toEqual({ targetingKey: 'user-1' });
  });

  it('keeps the last 10 contexts by revision and forgets older ones', () => {
    const state = new FlagsState(anonymousContext);
    for (let i = 1; i <= 11; i += 1) {
      state.applyContextUpdate({ targetingKey: `user-${i}` });
    }
    expect(state.getContext(1)).toBeUndefined();
    expect(state.getContext(2)).toEqual({ targetingKey: 'user-2' });
    expect(state.getContext(11)).toEqual({ targetingKey: 'user-11' });
    expect(state.getContext(0)).toBeUndefined();
  });

  it('notifies subscribers synchronously through monitor', () => {
    const state = new FlagsState(anonymousContext);
    const snapshots: number[] = [];
    state.subscribe((snapshot) => snapshots.push(snapshot.revision));
    state.applyConfigurationUpdate({ configuration: 'wire-1', status: 'READY' });
    // Synchronous: the subscriber already saw the update.
    expect(snapshots).toEqual([1]);
    state.applyConfigurationUpdate({ configuration: 'wire-2', status: 'READY' });
    expect(snapshots).toEqual([1, 2]);
  });

  it('a context change leaves configuration untouched', () => {
    const state = new FlagsState(anonymousContext);
    state.applyConfigurationUpdate({ configuration: 'wire-1', status: 'READY' });
    state.applyContextUpdate({ targetingKey: 'user-1' });
    expect(state.snapshot().configuration).toBe('wire-1');
    expect(state.snapshot().configurationRevision).toBe(1);
    expect(state.getContext(1)).toEqual({ targetingKey: 'user-1' });
  });

  it('carries status and error message on the snapshot', () => {
    const state = new FlagsState(anonymousContext);
    state.applyConfigurationUpdate({ status: 'ERROR', errorMessage: 'org setting off' });
    expect(state.snapshot().status).toBe('ERROR');
    expect(state.snapshot().errorMessage).toBe('org setting off');
    expect(state.snapshot().configuration).toBeUndefined();
  });

  it('updates tracking without touching configuration or context revisions', () => {
    const state = new FlagsState(anonymousContext);
    state.applyConfigurationUpdate({ configuration: 'wire-1', status: 'READY' });
    state.applyContextUpdate({ targetingKey: 'user-1' });
    state.setTracking({ exposures: false, rum: false, evaluations: false });
    const snapshot = state.snapshot();
    expect(snapshot.tracking).toEqual({ exposures: false, rum: false, evaluations: false });
    expect(snapshot.configurationRevision).toBe(1);
    expect(snapshot.contextRevision).toBe(1);
    expect(snapshot.revision).toBe(3);
  });

  describe('immutability', () => {
    it("copies the caller's context and tracking: mutating the inputs never changes retained state", () => {
      const initial: FlatContext = { targetingKey: 'anonymous-key', plan: 'free' };
      const tracking = { exposures: true, rum: true, evaluations: true };
      const state = new FlagsState(initial, tracking);
      const next: FlatContext = { targetingKey: 'user-1', plan: 'pro' };
      state.applyContextUpdate(next);
      const nextTracking = { exposures: false, rum: true, evaluations: true };
      state.setTracking(nextTracking);

      initial.plan = 'tampered';
      next.plan = 'tampered';
      nextTracking.rum = false;
      tracking.exposures = false;

      expect(state.getContext(0)).toEqual({ targetingKey: 'anonymous-key', plan: 'free' });
      expect(state.getContext(1)).toEqual({ targetingKey: 'user-1', plan: 'pro' });
      expect(state.snapshot().context).toEqual({ targetingKey: 'user-1', plan: 'pro' });
      expect(state.snapshot().tracking).toEqual({ exposures: false, rum: true, evaluations: true });
      // Caller-owned objects are never frozen.
      for (const input of [initial, next, tracking, nextTracking]) expect(Object.isFrozen(input)).toBe(false);
    });

    it('published snapshots, their context and tracking, and retained contexts cannot be mutated', () => {
      const state = new FlagsState({ targetingKey: 'anonymous-key' });
      const received: FlagsSnapshot[] = [];
      state.subscribe((snapshot) => received.push(snapshot));
      state.applyConfigurationUpdate({ configuration: 'wire-1', status: 'READY' });
      state.applyContextUpdate({ targetingKey: 'user-1', plan: 'pro' });
      state.setTracking({ exposures: false, rum: true, evaluations: true });
      const published = [state.snapshot(), ...received];
      for (const snapshot of published) {
        expect(() => {
          (snapshot as { revision: number }).revision = 99;
        }).toThrow(TypeError);
        expect(() => {
          (snapshot.context as Record<string, unknown>).plan = 'tampered';
        }).toThrow(TypeError);
        expect(() => {
          (snapshot.tracking as { exposures: boolean }).exposures = true;
        }).toThrow(TypeError);
      }
      expect(() => {
        (state.getContext(1) as Record<string, unknown>).plan = 'tampered';
      }).toThrow(TypeError);
      expect(state.getContext(1)).toEqual({ targetingKey: 'user-1', plan: 'pro' });
      expect(state.snapshot().revision).toBe(3);
    });
  });

  describe('precomputed', () => {
    it('publishes assignments and their context atomically, bumping both revisions', () => {
      const state = new FlagsState(anonymousContext);
      state.applyConfigurationUpdate({ configuration: 'wire-1', status: 'READY' });
      const received: FlagsSnapshot[] = [];
      state.subscribe((snapshot) => received.push(snapshot));
      state.applyPrecomputedUpdate({
        configuration: 'wire-2',
        context: { targetingKey: 'user-1' },
        status: 'READY',
        configurationIdentity: 'created-at-1',
      });
      // One notification, one revision bump, both sub-revisions advanced together.
      expect(received).toHaveLength(1);
      expect(state.snapshot()).toMatchObject({
        revision: 2,
        status: 'READY',
        configuration: 'wire-2',
        context: { targetingKey: 'user-1' },
        contextRevision: 1,
        configurationRevision: 2,
      });
      expect(state.getConfigurationIdentity(1)).toBe('created-at-1');
    });

    it('keeps the contextRevision when the same context is re-applied with a new configuration, and replaces its identity', () => {
      const state = new FlagsState(anonymousContext);
      state.applyPrecomputedUpdate({
        configuration: 'wire-1',
        context: { targetingKey: 'user-1', plan: 'pro' },
        status: 'READY',
        configurationIdentity: 'created-at-1',
      });
      state.applyPrecomputedUpdate({
        configuration: 'wire-2',
        context: { targetingKey: 'user-1', plan: 'pro' },
        status: 'READY',
        configurationIdentity: 'created-at-2',
      });
      expect(state.snapshot().contextRevision).toBe(1);
      expect(state.snapshot().configurationRevision).toBe(2);
      expect(state.getConfigurationIdentity(1)).toBe('created-at-2');
    });

    it('retains the configuration identity per contextRevision and forgets it with the context', () => {
      const state = new FlagsState(anonymousContext);
      for (let i = 1; i <= 11; i += 1) {
        state.applyPrecomputedUpdate({
          configuration: `wire-${i}`,
          context: { targetingKey: `user-${i}` },
          status: 'READY',
          configurationIdentity: `created-at-${i}`,
        });
      }
      expect(state.getConfigurationIdentity(1)).toBeUndefined();
      expect(state.getConfigurationIdentity(11)).toBe('created-at-11');
    });

    it('publishes a pending context with no configuration for a defaults (in-flight) update', () => {
      const state = new FlagsState(anonymousContext);
      state.applyPrecomputedUpdate({
        configuration: 'wire-1',
        context: { targetingKey: 'user-1' },
        status: 'READY',
        configurationIdentity: 'created-at-1',
      });
      state.applyPrecomputedUpdate({
        configuration: undefined,
        context: { targetingKey: 'user-2' },
        status: 'NOT_READY',
      });
      expect(state.snapshot()).toMatchObject({
        status: 'NOT_READY',
        configuration: undefined,
        context: { targetingKey: 'user-2' },
        contextRevision: 2,
      });
      // The configurationRevision is untouched: no configuration was served.
      expect(state.snapshot().configurationRevision).toBe(1);
      // The pending context is retained by its revision.
      expect(state.getContext(2)).toEqual({ targetingKey: 'user-2' });
      expect(state.getConfigurationIdentity(2)).toBeUndefined();
    });
  });
});
