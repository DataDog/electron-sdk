import { describe, expect, it, vi } from 'vitest';
import { createTrackingConsentState } from '../tracking-consent';
import { ContextManager, type ContextHistory } from './contextManager';

function createHistory() {
  const closeActive = vi.fn();
  const closeAndAdd = vi.fn();
  const pausePersistence = vi.fn();
  const commitPausedChanges = vi.fn();
  const discardPausedChanges = vi.fn();
  const history = {
    add: vi.fn(),
    closeActive,
    closeAndAdd,
    pruneAndPersist: vi.fn(),
    find: vi.fn(),
    pausePersistence,
    commitPausedChanges,
    discardPausedChanges,
  } satisfies ContextHistory;

  return { history, closeActive, closeAndAdd, pausePersistence, commitPausedChanges, discardPausedChanges };
}

describe('ContextManager tracking consent', () => {
  it('commits customer context history when pending consent is granted', () => {
    const { history, pausePersistence, commitPausedChanges, discardPausedChanges } = createHistory();
    const state = createTrackingConsentState('pending');
    const context = new ContextManager('test context', {}, history, state);

    context.setContext({ id: 'user-1' });
    state.update('granted');

    expect(pausePersistence).toHaveBeenCalledOnce();
    expect(commitPausedChanges).toHaveBeenCalledOnce();
    expect(discardPausedChanges).not.toHaveBeenCalled();
  });

  it('discards rejected pending history and starts the current context at a later grant', () => {
    const { history, closeAndAdd, commitPausedChanges, discardPausedChanges } = createHistory();
    const state = createTrackingConsentState('pending');
    const context = new ContextManager('test context', {}, history, state);

    context.setContext({ id: 'user-1' });
    state.update('not-granted');
    state.update('granted');

    expect(discardPausedChanges).toHaveBeenCalledTimes(2);
    expect(commitPausedChanges).not.toHaveBeenCalled();
    expect(closeAndAdd).toHaveBeenLastCalledWith({ id: 'user-1' }, expect.any(Number));
  });

  it('closes authorized history before keeping denied changes in memory', () => {
    const { history, closeActive, pausePersistence } = createHistory();
    const state = createTrackingConsentState('granted');
    const context = new ContextManager('test context', {}, history, state);
    context.setContext({ id: 'user-1' });

    state.update('not-granted');

    expect(closeActive).toHaveBeenCalledWith(expect.any(Number));
    expect(pausePersistence).toHaveBeenCalledOnce();
  });
});
