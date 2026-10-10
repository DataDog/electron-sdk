import { describe, it, expect, vi } from 'vitest';
import { createFormatHooks, type FormatHooks } from '../../assembly';
import { EventSource } from '../../event';
import type { TimeStamp } from '@datadog/js-core/time';
import { FeatureFlagsRumContext } from './FeatureFlagsRumContext';

function createContext(
  viewById: Record<string, [TimeStamp, TimeStamp]> = { 'view-1': [0 as never, 1000 as never] },
  options: { enabled?: boolean } = {}
) {
  const hooks = createFormatHooks();
  const findViewId = vi.fn((atTime: TimeStamp) => {
    for (const [id, [start, end]] of Object.entries(viewById)) {
      if (atTime >= start && atTime < end) return id;
    }
    return undefined;
  });
  const requestViewUpdate = vi.fn();
  const context = new FeatureFlagsRumContext({
    hooks,
    findViewId: findViewId,
    requestViewUpdate,
    enabled: () => options.enabled ?? true,
  });
  return { hooks, context, requestViewUpdate, findViewId };
}

function triggerView(hooks: FormatHooks, startTime: TimeStamp, source: EventSource = EventSource.MAIN) {
  return hooks.triggerRum({ eventType: 'view', startTime, source });
}

function triggerError(hooks: FormatHooks, startTime: TimeStamp, source: EventSource = EventSource.MAIN) {
  return hooks.triggerRum({ eventType: 'error', startTime, source });
}

describe('FeatureFlagsRumContext', () => {
  it('a main view update includes every flag recorded for that view, including ones evaluated after the view started', () => {
    const { hooks, context } = createContext();
    context.record('flag-a', 'on', 500 as never);
    context.record('flag-b', 'off', 700 as never);
    expect(triggerView(hooks, 0 as never)).toEqual({ feature_flags: { 'flag-a': 'on', 'flag-b': 'off' } });
  });

  it('a main error includes, per flag, the last variant recorded at or before its startTime', () => {
    const { hooks, context } = createContext();
    context.record('flag-a', 'on', 100 as never);
    context.record('flag-a', 'off', 800 as never);
    expect(triggerError(hooks, 500 as never)).toEqual({ feature_flags: { 'flag-a': 'on' } });
    expect(triggerError(hooks, 900 as never)).toEqual({ feature_flags: { 'flag-a': 'off' } });
  });

  it('a flag first recorded after the error startTime is not attached to that error', () => {
    const { hooks, context } = createContext();
    context.record('flag-late', 'on', 600 as never);
    expect(triggerError(hooks, 300 as never)).toBeUndefined();
  });

  it('a new flag or changed variant requests one throttled view update; a repeated identical evaluation does not', () => {
    const { context, requestViewUpdate } = createContext();
    context.record('flag-a', 'on', 100 as never);
    context.record('flag-a', 'on', 200 as never);
    expect(requestViewUpdate).toHaveBeenCalledTimes(1);
    context.record('flag-a', 'off', 300 as never);
    expect(requestViewUpdate).toHaveBeenCalledTimes(2);
  });

  it('orders by evaluation time, not arrival: a late older record does not overwrite newer state (R3)', () => {
    const { hooks, context, requestViewUpdate } = createContext();
    context.record('flag-a', 'new', 200 as never); // main, evaluated at 200
    context.record('flag-a', 'old', 100 as never); // child, evaluated at 100, arrives later
    expect(triggerView(hooks, 0 as never)).toEqual({ feature_flags: { 'flag-a': 'new' } });
    expect(triggerError(hooks, 250 as never)).toEqual({ feature_flags: { 'flag-a': 'new' } });
    expect(triggerError(hooks, 150 as never)).toEqual({ feature_flags: { 'flag-a': 'old' } });
    // The late record changed only the past: the view document did not change.
    expect(requestViewUpdate).toHaveBeenCalledTimes(1);
  });

  it('a late repeat of the current variant extends it back in time without a view update (R3)', () => {
    const { hooks, context, requestViewUpdate } = createContext();
    context.record('flag-a', 'on', 300 as never);
    context.record('flag-a', 'on', 100 as never);
    expect(triggerError(hooks, 150 as never)).toEqual({ feature_flags: { 'flag-a': 'on' } });
    expect(requestViewUpdate).toHaveBeenCalledTimes(1);
  });

  it('a late record between two variants is placed by time (R3)', () => {
    const { hooks, context } = createContext();
    context.record('flag-a', 'one', 100 as never);
    context.record('flag-a', 'three', 300 as never);
    context.record('flag-a', 'two', 200 as never);
    context.record('flag-a', 'one', 150 as never); // repeat of its predecessor: no change
    expect(triggerError(hooks, 120 as never)).toEqual({ feature_flags: { 'flag-a': 'one' } });
    expect(triggerError(hooks, 160 as never)).toEqual({ feature_flags: { 'flag-a': 'one' } });
    expect(triggerError(hooks, 250 as never)).toEqual({ feature_flags: { 'flag-a': 'two' } });
    expect(triggerError(hooks, 350 as never)).toEqual({ feature_flags: { 'flag-a': 'three' } });
    expect(triggerView(hooks, 0 as never)).toEqual({ feature_flags: { 'flag-a': 'three' } });
  });

  it('after a view change the new view starts with no flags, and the previous view keeps its flags', () => {
    const { hooks, context } = createContext({
      'view-1': [0 as never, 1000 as never],
      'view-2': [1000 as never, 2000 as never],
    });
    context.record('flag-a', 'on', 100 as never);
    // Session renew: a new view.
    context.record('flag-b', 'off', 1500 as never);
    expect(triggerView(hooks, 1000 as never)).toEqual({ feature_flags: { 'flag-b': 'off' } });
    // The previous view's final update still carries its flags.
    expect(triggerView(hooks, 0 as never)).toEqual({ feature_flags: { 'flag-a': 'on' } });
  });

  it('works with the execution-context fake view (requests the update from MainProcessContext)', () => {
    const { hooks, context, requestViewUpdate } = createContext({ 'fake-view': [0 as never, 1000 as never] });
    context.record('flag-a', 'on', 100 as never);
    expect(requestViewUpdate).toHaveBeenCalledTimes(1);
    expect(triggerView(hooks, 0 as never)).toEqual({ feature_flags: { 'flag-a': 'on' } });
  });

  it('a crash replayed from a previous run (unknown view id) gets no feature_flags', () => {
    const { hooks, context } = createContext({ 'view-1': [0 as never, 1000 as never] });
    context.record('flag-a', 'on', 100 as never);
    expect(triggerView(hooks, 5000 as never)).toBeUndefined();
    expect(triggerError(hooks, 5000 as never)).toBeUndefined();
  });

  it('returns SKIPPED for RENDERER source', () => {
    const { hooks, context } = createContext();
    context.record('flag-a', 'on', 100 as never);
    expect(triggerView(hooks, 0 as never, EventSource.RENDERER)).toBeUndefined();
    expect(triggerError(hooks, 100 as never, EventSource.RENDERER)).toBeUndefined();
  });

  it('disabled by enableRumFeatureFlagTracking false', () => {
    const { hooks, context, requestViewUpdate } = createContext(
      { 'view-1': [0 as never, 1000 as never] },
      { enabled: false }
    );
    context.record('flag-a', 'on', 100 as never);
    expect(requestViewUpdate).not.toHaveBeenCalled();
    expect(triggerView(hooks, 0 as never)).toBeUndefined();
  });

  it('records nothing for evaluations outside any view', () => {
    const { context, requestViewUpdate } = createContext();
    context.record('flag-a', 'on', 5000 as never);
    expect(requestViewUpdate).not.toHaveBeenCalled();
  });

  it('stop() clears the recorded state', () => {
    const { hooks, context } = createContext();
    context.record('flag-a', 'on', 100 as never);
    context.stop();
    expect(triggerView(hooks, 0 as never)).toBeUndefined();
  });
});
