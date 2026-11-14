import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { timeStampNow } from '@datadog/js-core/time';
import { createFormatHooks, type FormatHooks, type RumEventType } from '../../assembly';
import { EventSource } from '../../event';
import { mockFs } from '../../mocks.specUtil';
import { FeatureFlagContext } from './FeatureFlagContext';

vi.mock('electron', () => ({ app: { getPath: () => '/mock/user/data' } }));
vi.mock('node:fs/promises');
const mfs = mockFs();

describe('FeatureFlagContext', () => {
  let hooks: FormatHooks;
  let context: FeatureFlagContext;

  beforeEach(async () => {
    vi.useFakeTimers();
    mfs.readFile.mockRejectedValue(new Error('ENOENT'));
    mfs.writeFile.mockResolvedValue(undefined);
    hooks = createFormatHooks();
    context = await FeatureFlagContext.init(hooks);
  });

  afterEach(() => {
    vi.useRealTimers();
    mfs.reset();
  });

  function assemble(eventType: RumEventType = 'error', source: EventSource = EventSource.MAIN, at = timeStampNow()) {
    return hooks.triggerRum({ eventType, source, startTime: at });
  }

  it('contributes nothing before an evaluation, and ignores evaluations without an active view', () => {
    expect(context.addEvaluation('search', true)).toBe(false);
    context.startView(timeStampNow());
    expect(assemble()).toBeUndefined();
  });

  it('adds evaluations to views and errors, with the latest value for a repeated key', () => {
    context.startView(timeStampNow());
    context.addEvaluation('search', false);
    context.addEvaluation('theme', 'dark');
    context.addEvaluation('search', true);

    const expected = { feature_flags: { search: true, theme: 'dark' } };
    expect(assemble('view')).toEqual(expected);
    expect(assemble('error')).toEqual(expected);
  });

  it('leaves renderer events and other main-process event types untouched', () => {
    context.startView(timeStampNow());
    context.addEvaluation('search', true);

    expect(assemble('error', EventSource.RENDERER)).toBeUndefined();
    expect(assemble('view', EventSource.RENDERER)).toBeUndefined();
    for (const type of ['resource', 'vital', 'execution_context'] as const) {
      expect(assemble(type)).toBeUndefined();
    }
  });

  it.each(['resource', 'vital'] as const)(
    'includes flags on %s only when selected, keeping views and errors enabled',
    async (eventType) => {
      hooks = createFormatHooks();
      context = await FeatureFlagContext.init(hooks, [eventType]);
      context.startView(timeStampNow());
      context.addEvaluation('search', true);

      for (const type of ['view', 'error', eventType] as const) {
        expect(assemble(type)).toEqual({ feature_flags: { search: true } });
      }
      expect(assemble(eventType === 'resource' ? 'vital' : 'resource')).toBeUndefined();
      expect(assemble(eventType, EventSource.RENDERER)).toBeUndefined();
      expect(assemble('execution_context')).toBeUndefined();
    }
  );

  it('resolves delayed events to their view, including evaluations made after the view started', async () => {
    hooks = createFormatHooks();
    context = await FeatureFlagContext.init(hooks, ['resource', 'vital']);
    const firstStart = timeStampNow();
    context.startView(firstStart);
    vi.advanceTimersByTime(10);
    context.addEvaluation('search', 'old');
    vi.advanceTimersByTime(10);
    context.closeView(timeStampNow());
    expect(context.addEvaluation('search', 'outside-view')).toBe(false);
    vi.advanceTimersByTime(10);
    const secondStart = timeStampNow();
    context.startView(secondStart);
    expect(assemble()).toBeUndefined();
    context.addEvaluation('search', 'new');

    for (const type of ['view', 'error', 'resource', 'vital'] as const) {
      expect(assemble(type, EventSource.MAIN, firstStart)).toEqual({ feature_flags: { search: 'old' } });
      expect(assemble(type, EventSource.MAIN, secondStart)).toEqual({ feature_flags: { search: 'new' } });
    }
  });

  it('recovers a previous view for crash attribution without carrying its flags into the new view', async () => {
    const crashTime = timeStampNow();
    mfs.readFile.mockResolvedValue(
      JSON.stringify([{ value: { search: 'previous-run' }, startTime: crashTime, endTime: null }])
    );
    vi.advanceTimersByTime(10);
    hooks = createFormatHooks();
    context = await FeatureFlagContext.init(hooks);
    context.startView(timeStampNow());
    context.addEvaluation('search', 'current-run');

    expect(assemble('error', EventSource.MAIN, crashTime)).toEqual({ feature_flags: { search: 'previous-run' } });
    expect(assemble()).toEqual({ feature_flags: { search: 'current-run' } });
  });

  it('drops malformed persisted flag values', async () => {
    const crashTime = timeStampNow();
    mfs.readFile.mockResolvedValue(JSON.stringify([{ value: null, startTime: crashTime, endTime: null }]));
    vi.advanceTimersByTime(10);
    hooks = createFormatHooks();
    await FeatureFlagContext.init(hooks);

    expect(assemble('error', EventSource.MAIN, crashTime)).toBeUndefined();
  });
});
