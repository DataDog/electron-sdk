import { describe, it, expect } from 'vitest';
import { DISCARDED, type TimeStamp } from '@datadog/browser-core';
import { createFormatHooks } from '../../../assembly';
import { ViewContext } from './ViewContext';

const T0 = 0 as TimeStamp;
const VIEW_ID = 'view-1';

describe('ViewContext', () => {
  describe('before add()', () => {
    it('RUM hook returns DISCARDED', () => {
      const hooks = createFormatHooks();
      new ViewContext(hooks);

      expect(hooks.triggerRum({ eventType: 'view', startTime: T0 })).toBe(DISCARDED);
    });

    it('telemetry hook returns SKIPPED (undefined)', () => {
      const hooks = createFormatHooks();
      new ViewContext(hooks);

      expect(hooks.triggerTelemetry({ startTime: T0 })).toBeUndefined();
    });
  });

  describe('after add()', () => {
    it('RUM hook returns id, name, url', () => {
      const hooks = createFormatHooks();
      const context = new ViewContext(hooks);

      context.add(VIEW_ID);

      expect(hooks.triggerRum({ eventType: 'view', startTime: T0 })).toMatchObject({
        view: { id: VIEW_ID, name: 'main process', url: 'electron://main-process' },
      });
    });

    it('telemetry hook returns only id', () => {
      const hooks = createFormatHooks();
      const context = new ViewContext(hooks);

      context.add(VIEW_ID);

      expect(hooks.triggerTelemetry({ startTime: T0 })).toEqual({ view: { id: VIEW_ID } });
    });

    it('reflects the latest update()', () => {
      const hooks = createFormatHooks();
      const context = new ViewContext(hooks);
      const newViewId = 'view-2';

      context.add(VIEW_ID);
      context.add(newViewId);

      expect(hooks.triggerRum({ eventType: 'view', startTime: T0 })).toMatchObject({
        view: { id: newViewId },
      });
    });
  });

  describe('after close()', () => {
    it('RUM hook returns DISCARDED', () => {
      const hooks = createFormatHooks();
      const context = new ViewContext(hooks);

      context.add(VIEW_ID);
      context.close();

      expect(hooks.triggerRum({ eventType: 'view', startTime: T0 })).toBe(DISCARDED);
    });

    it('telemetry hook returns SKIPPED (undefined)', () => {
      const hooks = createFormatHooks();
      const context = new ViewContext(hooks);

      context.add(VIEW_ID);
      context.close();

      expect(hooks.triggerTelemetry({ startTime: T0 })).toBeUndefined();
    });
  });
});
