import { afterEach, describe, expect, it, vi } from 'vitest';
import { DiskValueHistory } from '../../tools/DiskValueHistory';
import { createTestConfiguration, mockFs } from '../../mocks.specUtil';
import { EventManager, EventKind, EventFormat, type RawTelemetryEvent } from '../../event';
import { startTelemetry, stopTelemetry } from '../telemetry';
import { createTrackingConsentState } from '../tracking-consent';
import { ContextManager, type ContextHistory } from './contextManager';

vi.mock('node:fs/promises');
const mfs = mockFs();

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
  afterEach(() => {
    stopTelemetry();
    mfs.reset();
  });

  it('reports a pending context serialization error without interrupting later consent observers', async () => {
    mfs.readFile.mockRejectedValue(new Error('ENOENT'));
    mfs.writeFile.mockResolvedValue(undefined);
    const state = createTrackingConsentState('pending');
    const eventManager = new EventManager();
    const errors: RawTelemetryEvent[] = [];
    eventManager.registerHandler<RawTelemetryEvent>({
      canHandle: (event): event is RawTelemetryEvent =>
        event.kind === EventKind.RAW && event.format === EventFormat.TELEMETRY,
      handle: (event) => errors.push(event),
    });
    startTelemetry(eventManager, createTestConfiguration({ telemetrySampleRate: 100 }), state);
    const history = await DiskValueHistory.init<Record<string, unknown>>({
      filePath: '/mock/user-context',
      expireDelay: 60_000,
    });
    const context = new ContextManager('test context', {}, history, state);
    const laterObserver = vi.fn();
    state.observable.subscribe(laterObserver);
    context.setContext({ extraInfo: { value: 1n } });

    expect(() => state.update('granted')).not.toThrow();

    expect(laterObserver).toHaveBeenCalledWith({ previous: 'pending', current: 'granted' });
    expect(errors).toHaveLength(1);
    expect(errors[0].data.telemetry).toMatchObject({ type: 'log', status: 'error' });
  });

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
