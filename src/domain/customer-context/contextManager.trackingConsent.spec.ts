import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TimeStamp } from '@datadog/js-core/time';
import { createFormatHooks, type FormatHooks } from '../../assembly';
import { EventKind, EventManager, EventSource, type RawEvent } from '../../event';
import { createTestConfiguration, mockFs } from '../../mocks.specUtil';
import { ContextHistoryFactory, TrackingConsentManager } from '../tracking-consent';
import { SESSION_TIME_OUT_DELAY } from '../session';
import { startTelemetry, stopTelemetry } from '../telemetry';
import { UserContext } from './userContext';
import { AccountContext } from './accountContext';
import { GlobalContext } from './globalContext';

vi.mock('electron', () => ({ app: { getPath: vi.fn(() => '/mock/user/data') } }));
vi.mock('node:fs/promises');
const mfs = mockFs();

let manager: TrackingConsentManager;
let histories: ContextHistoryFactory;
let hooks: FormatHooks;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1000);
  manager = new TrackingConsentManager();
  histories = new ContextHistoryFactory(manager, '/mock/user/data');
  hooks = createFormatHooks();
  mfs.readFile.mockRejectedValue(new Error('ENOENT'));
  mfs.writeFile.mockResolvedValue(undefined);
});

afterEach(() => {
  histories.stop();
  stopTelemetry();
  mfs.reset();
  vi.useRealTimers();
});

describe.each([
  ['user', UserContext, 'usr'],
  ['account', AccountContext, 'account'],
  ['global', GlobalContext, 'context'],
] as const)('%s context consent history', (_name, ContextType, key) => {
  function contextAt(startTime: TimeStamp) {
    const event = hooks.triggerRum({ eventType: 'error', startTime, source: EventSource.MAIN }) as
      Partial<Record<typeof key, unknown>> | undefined;
    return event?.[key] ?? {};
  }

  it('keeps pending customer context available and persists it on grant', async () => {
    manager.update('pending');
    const context = await ContextType.init(hooks, histories);

    await vi.advanceTimersByTimeAsync(0);
    mfs.writeFile.mockClear();
    vi.setSystemTime(1010);
    context.setContext({ id: 'pending', extraInfo: { plan: 'premium' } });
    const pending = context.getContext();
    await vi.advanceTimersByTimeAsync(0);

    expect(contextAt(1010 as TimeStamp)).toEqual(pending);
    expect(mfs.writeFile).not.toHaveBeenCalled();

    vi.setSystemTime(1020);
    manager.update('granted');
    await vi.advanceTimersByTimeAsync(0);

    expect(lastWrittenHistory()).toContainEqual(expect.objectContaining({ value: pending }));
  });

  it('rejects pending history while preserving the current customer value for a later grant', async () => {
    manager.update('pending');
    const context = await ContextType.init(hooks, histories);

    vi.setSystemTime(1010);
    context.setContext({ id: 'rejected' });
    vi.setSystemTime(1020);
    manager.update('not-granted');

    expect(context.getContext()).toEqual({ id: 'rejected' });
    expect(contextAt(1010 as TimeStamp)).toEqual({});

    vi.setSystemTime(1030);
    context.setContext({ id: 'current' });
    expect(context.getContext()).toEqual({ id: 'current' });
    expect(contextAt(1030 as TimeStamp)).toEqual({});

    vi.setSystemTime(1040);
    manager.update('granted');

    expect(contextAt(1010 as TimeStamp)).toEqual({});
    expect(contextAt(1030 as TimeStamp)).toEqual({});
    expect(contextAt(1040 as TimeStamp)).toEqual({ id: 'current' });
  });

  it('restores authorized attribution after restart without restoring pending or current customer context', async () => {
    const context = await ContextType.init(hooks, histories);

    vi.setSystemTime(1010);
    context.setContext({ id: 'authorized' });
    vi.setSystemTime(1020);
    manager.update('pending');
    vi.setSystemTime(1030);
    context.setContext({ id: 'pending' });
    await vi.advanceTimersByTimeAsync(0);
    histories.stop();

    mfs.readFile.mockResolvedValue(JSON.stringify(lastWrittenHistory()));
    vi.setSystemTime(1100);
    histories = new ContextHistoryFactory(new TrackingConsentManager(), '/mock/user/data');
    hooks = createFormatHooks();
    const restarted = await ContextType.init(hooks, histories);

    expect(contextAt(1010 as TimeStamp)).toEqual({ id: 'authorized' });
    expect(contextAt(1030 as TimeStamp)).toEqual({});
    expect(restarted.getContext()).toEqual({});
  });
});

it('preserves a global attribute named extraInfo through a pending grant', async () => {
  manager.update('pending');
  const context = await GlobalContext.init(hooks, histories);

  vi.setSystemTime(1010);
  context.setContext({ extraInfo: { plan: 'premium' } });
  vi.setSystemTime(1020);
  manager.update('granted');
  await vi.advanceTimersByTimeAsync(0);

  expect(hooks.triggerRum({ eventType: 'error', startTime: 1010 as TimeStamp, source: EventSource.MAIN })).toEqual({
    context: { extraInfo: { plan: 'premium' } },
  });
  expect(lastWrittenHistory()).toEqual([{ startTime: 1010, endTime: null, value: { extraInfo: { plan: 'premium' } } }]);
});

it('reports a context serialization error without interrupting later consent observers', async () => {
  const eventManager = new EventManager();
  const onTelemetry = vi.fn<(event: RawEvent) => void>();
  eventManager.registerHandler<RawEvent>({
    canHandle: (event) => event.kind === EventKind.RAW,
    handle: (event) => onTelemetry(event),
  });
  startTelemetry(eventManager, createTestConfiguration({ telemetrySampleRate: 100 }));
  manager.update('pending');
  const context = await UserContext.init(hooks, histories);

  context.setContext({ id: 'user', extraInfo: { value: 1n } });
  const laterObserver = vi.fn();
  manager.subscribe(laterObserver);

  expect(() => manager.update('granted')).not.toThrow();

  expect(laterObserver).toHaveBeenCalledWith({ previous: 'pending', current: 'granted', time: 1000 });
  expect(onTelemetry.mock.calls).toMatchObject([[{ data: { telemetry: { status: 'error' } } }]]);
});

it('keeps pending context off disk when closing the granted history fails serialization', async () => {
  const context = await UserContext.init(hooks, histories);

  await vi.advanceTimersByTimeAsync(0);
  mfs.writeFile.mockClear();
  vi.setSystemTime(1010);
  expect(() => context.setContext({ id: 'authorized', extraInfo: { value: 1n } })).toThrow(TypeError);

  vi.setSystemTime(1020);
  expect(() => manager.update('pending')).not.toThrow();

  // Once the invalid closed entry expires, a valid update must still stay in memory.
  vi.setSystemTime(1020 + SESSION_TIME_OUT_DELAY + 1);
  context.setContext({ id: 'pending' });
  await vi.advanceTimersByTimeAsync(0);

  expect(mfs.writeFile).not.toHaveBeenCalled();
});

it('stops history persistence when its factory stops', async () => {
  manager.update('pending');
  const context = await UserContext.init(hooks, histories);

  context.setContext({ id: 'pending' });
  await vi.advanceTimersByTimeAsync(0);
  mfs.writeFile.mockClear();

  histories.stop();
  manager.update('granted');
  await vi.advanceTimersByTimeAsync(0);

  expect(mfs.writeFile).not.toHaveBeenCalled();
});

function lastWrittenHistory(): unknown {
  const lastWrite = mfs.writeFile.mock.calls[mfs.writeFile.mock.calls.length - 1];
  return JSON.parse(lastWrite[1] as string);
}
