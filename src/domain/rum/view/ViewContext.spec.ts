import { mockFs } from '../../../mocks.specUtil';

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/mock/user/data') },
}));

vi.mock('../../../tools/display', () => ({
  display: { error: vi.fn() },
}));

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { TimeStamp } from '@datadog/js-core/time';
import { DISCARDED } from '@datadog/js-core/assembly';
import { createFormatHooks } from '../../../assembly';
import { EventSource } from '../../../event';
import { ViewContext } from './ViewContext';

vi.mock('node:fs/promises');
const mfs = mockFs();

// Fake time starts at T0 = 0 so that timeStampNow() aligns with T0
const T0 = 0 as TimeStamp;
const VIEW_ID = 'view-1';
const EXPIRE_DELAY = 1000;

describe('ViewContext', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    mfs.readFile.mockRejectedValue(new Error('ENOENT'));
    mfs.writeFile.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    mfs.reset();
  });

  describe('before add()', () => {
    it('RUM hook returns DISCARDED', async () => {
      const hooks = createFormatHooks();
      await ViewContext.init(hooks, EXPIRE_DELAY);

      expect(hooks.triggerRum({ eventType: 'view', startTime: T0, source: EventSource.MAIN })).toBe(DISCARDED);
    });

    it('span hook returns DISCARDED', async () => {
      const hooks = createFormatHooks();
      await ViewContext.init(hooks, EXPIRE_DELAY);

      expect(hooks.triggerSpan({ startTime: T0, source: EventSource.MAIN })).toBe(DISCARDED);
    });

    it('telemetry hook returns SKIPPED (undefined)', async () => {
      const hooks = createFormatHooks();
      await ViewContext.init(hooks, EXPIRE_DELAY);

      expect(hooks.triggerTelemetry({ startTime: T0, source: EventSource.MAIN })).toBeUndefined();
    });
  });

  describe('after add()', () => {
    it('RUM hook returns id, name, url for main source', async () => {
      const hooks = createFormatHooks();
      const context = await ViewContext.init(hooks, EXPIRE_DELAY);

      context.add(VIEW_ID);

      expect(hooks.triggerRum({ eventType: 'view', startTime: T0, source: EventSource.MAIN })).toMatchObject({
        view: { id: VIEW_ID, name: 'main process', url: 'electron://main-process' },
      });
    });

    it('RUM hook returns container.view.id for renderer source', async () => {
      const hooks = createFormatHooks();
      const context = await ViewContext.init(hooks, EXPIRE_DELAY);

      context.add(VIEW_ID);

      expect(hooks.triggerRum({ eventType: 'view', startTime: T0, source: EventSource.RENDERER })).toMatchObject({
        container: { view: { id: VIEW_ID } },
      });
    });

    it('RUM hook does not include view.name/url for renderer source', async () => {
      const hooks = createFormatHooks();
      const context = await ViewContext.init(hooks, EXPIRE_DELAY);

      context.add(VIEW_ID);

      const result = hooks.triggerRum({ eventType: 'view', startTime: T0, source: EventSource.RENDERER });
      expect(result).not.toHaveProperty('view.name');
      expect(result).not.toHaveProperty('view.url');
    });

    it('span hook returns view id', async () => {
      const hooks = createFormatHooks();
      const context = await ViewContext.init(hooks, EXPIRE_DELAY);

      context.add(VIEW_ID);

      expect(hooks.triggerSpan({ startTime: T0, source: EventSource.MAIN })).toMatchObject({
        meta: {
          '_dd.view.id': VIEW_ID,
        },
      });
    });

    it('telemetry hook returns only id', async () => {
      const hooks = createFormatHooks();
      const context = await ViewContext.init(hooks, EXPIRE_DELAY);

      context.add(VIEW_ID);

      expect(hooks.triggerTelemetry({ startTime: T0, source: EventSource.MAIN })).toEqual({ view: { id: VIEW_ID } });
    });

    it('reflects the latest add()', async () => {
      const hooks = createFormatHooks();
      const context = await ViewContext.init(hooks, EXPIRE_DELAY);
      const newViewId = 'view-2';

      context.add(VIEW_ID); // at T0
      vi.advanceTimersByTime(10); // advance to T10
      context.add(newViewId); // at T10

      expect(
        hooks.triggerRum({ eventType: 'view', startTime: 10 as TimeStamp, source: EventSource.MAIN })
      ).toMatchObject({
        view: { id: newViewId },
      });
    });
  });

  describe('after close()', () => {
    it('RUM hook still attributes events during the view period', async () => {
      const hooks = createFormatHooks();
      const context = await ViewContext.init(hooks, EXPIRE_DELAY);

      context.add(VIEW_ID); // at T0 = 0
      vi.advanceTimersByTime(10); // time is now 10
      context.close(); // closed at T10

      // event at T0 (during active period) is still attributed
      expect(hooks.triggerRum({ eventType: 'view', startTime: T0, source: EventSource.MAIN })).toMatchObject({
        view: { id: VIEW_ID },
      });
    });

    it('RUM hook returns DISCARDED for events before the view started', async () => {
      const hooks = createFormatHooks();
      const context = await ViewContext.init(hooks, EXPIRE_DELAY);

      vi.advanceTimersByTime(10); // advance to T10
      context.add(VIEW_ID); // view started at T10
      context.close();

      // event at T0 (before view started at T10) → DISCARDED
      expect(hooks.triggerRum({ eventType: 'view', startTime: T0, source: EventSource.MAIN })).toBe(DISCARDED);
    });

    it('span hook still attributes events during the view period', async () => {
      const hooks = createFormatHooks();
      const context = await ViewContext.init(hooks, EXPIRE_DELAY);

      context.add(VIEW_ID); // at T0 = 0
      vi.advanceTimersByTime(10); // time is now 10
      context.close(); // closed at T10

      // event at T0 (during active period) is still attributed
      expect(hooks.triggerSpan({ startTime: T0, source: EventSource.MAIN })).toMatchObject({
        meta: {
          '_dd.view.id': VIEW_ID,
        },
      });
    });

    it('span hook returns DISCARDED for events before the view started', async () => {
      const hooks = createFormatHooks();
      const context = await ViewContext.init(hooks, EXPIRE_DELAY);

      vi.advanceTimersByTime(10); // advance to T10
      context.add(VIEW_ID); // view started at T10
      context.close();

      // event at T0 (before view started at T10) → DISCARDED
      expect(hooks.triggerSpan({ startTime: T0, source: EventSource.MAIN })).toBe(DISCARDED);
    });

    it('telemetry hook still attributes events during the view period', async () => {
      const hooks = createFormatHooks();
      const context = await ViewContext.init(hooks, EXPIRE_DELAY);

      context.add(VIEW_ID); // at T0 = 0
      vi.advanceTimersByTime(10);
      context.close();

      expect(hooks.triggerTelemetry({ startTime: T0, source: EventSource.MAIN })).toMatchObject({
        view: { id: VIEW_ID },
      });
    });
  });
});
