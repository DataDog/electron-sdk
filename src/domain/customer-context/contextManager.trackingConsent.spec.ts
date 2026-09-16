import { describe, expect, it, vi } from 'vitest';
import { createTrackingConsentState } from '../tracking-consent';
import { ContextManager, type ContextHistory } from './contextManager';

function createHistory(): ContextHistory {
  return {
    add: vi.fn(),
    closeActive: vi.fn(),
    closeAndAdd: vi.fn(),
    pruneAndPersist: vi.fn(),
    find: vi.fn(),
    pausePersistence: vi.fn(),
    commitPausedChanges: vi.fn(),
    discardPausedChanges: vi.fn(),
  };
}

describe('ContextManager tracking consent', () => {
  it('commits customer context history when pending consent is granted', () => {
    const history = createHistory();
    const state = createTrackingConsentState('pending');
    const context = new ContextManager('test context', {}, history, state);

    context.setContext({ id: 'user-1' });
    state.update('granted');

    expect(history.pausePersistence).toHaveBeenCalledOnce();
    expect(history.commitPausedChanges).toHaveBeenCalledOnce();
    expect(history.discardPausedChanges).not.toHaveBeenCalled();
  });

  it('discards rejected pending history and starts the current context at a later grant', () => {
    const history = createHistory();
    const state = createTrackingConsentState('pending');
    const context = new ContextManager('test context', {}, history, state);

    context.setContext({ id: 'user-1' });
    state.update('not-granted');
    state.update('granted');

    expect(history.discardPausedChanges).toHaveBeenCalledTimes(2);
    expect(history.commitPausedChanges).not.toHaveBeenCalled();
    expect(history.closeAndAdd).toHaveBeenLastCalledWith({ id: 'user-1' }, expect.any(Number));
  });

  it('closes authorized history before keeping denied changes in memory', () => {
    const history = createHistory();
    const state = createTrackingConsentState('granted');
    const context = new ContextManager('test context', {}, history, state);
    context.setContext({ id: 'user-1' });

    state.update('not-granted');

    expect(history.closeActive).toHaveBeenCalledWith(expect.any(Number));
    expect(history.pausePersistence).toHaveBeenCalledOnce();
  });
});
