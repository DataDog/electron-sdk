import { beforeEach, describe, expect, it, vi } from 'vitest';

const { display, rumApi } = vi.hoisted(() => ({
  display: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
  rumApi: {
    addDurationVital: vi.fn(),
    startDurationVital: vi.fn(),
    stopDurationVital: vi.fn(),
  },
}));

vi.mock('./domain/telemetry', () => ({
  callMonitored: (callback: () => unknown) => callback(),
}));
vi.mock('./tools/display', () => ({ display }));

import { addDurationVital, setDurationVitalApi, startDurationVital, stopDurationVital } from './api';

describe.sequential('duration vital public API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setDurationVitalApi(undefined);
  });

  it('validates arguments before initialization', () => {
    addDurationVital('', { startTime: 0, duration: 1 });

    expect(display.error).toHaveBeenCalledOnce();
    expect(rumApi.addDurationVital).not.toHaveBeenCalled();
  });

  describe('after initialization', () => {
    beforeEach(() => {
      setDurationVitalApi(rumApi);
    });

    it('sanitizes and forwards duration vital options', () => {
      const addContext = { nested: { source: 'add' } };
      const startContext = { nested: { source: 'start' } };
      const stopContext = { nested: { source: 'stop' } };

      addDurationVital('database.migration', {
        startTime: 500,
        duration: 1_234,
        vitalKey: 'direct',
        context: addContext,
        description: 'migration',
      });
      startDurationVital('document.open', {
        vitalKey: 'document-1',
        context: startContext,
        description: 'opening',
      });
      stopDurationVital('document.open', {
        vitalKey: 'document-1',
        context: stopContext,
        description: 'opened',
      });

      addContext.nested.source = 'changed';
      startContext.nested.source = 'changed';
      stopContext.nested.source = 'changed';

      expect(rumApi.addDurationVital).toHaveBeenCalledWith('database.migration', {
        startTime: 500,
        duration: 1_234,
        vitalKey: 'direct',
        context: { nested: { source: 'add' } },
        description: 'migration',
      });
      expect(rumApi.startDurationVital).toHaveBeenCalledWith('document.open', {
        vitalKey: 'document-1',
        context: { nested: { source: 'start' } },
        description: 'opening',
      });
      expect(rumApi.stopDurationVital).toHaveBeenCalledWith('document.open', {
        vitalKey: 'document-1',
        context: { nested: { source: 'stop' } },
        description: 'opened',
      });
    });

    it.each([
      ['blank name', '', { startTime: 0, duration: 1 }],
      ['missing options', 'vital', undefined],
      ['non-finite startTime', 'vital', { startTime: Number.NaN, duration: 1 }],
      ['non-finite duration', 'vital', { startTime: 0, duration: Number.POSITIVE_INFINITY }],
    ])('rejects invalid addDurationVital input: %s', (_label, name, options) => {
      addDurationVital(name, options as never);

      expect(rumApi.addDurationVital).not.toHaveBeenCalled();
      expect(display.error).toHaveBeenCalledOnce();
    });

    it('rejects invalid startDurationVital options', () => {
      startDurationVital('checkout', { context: 'invalid' } as never);

      expect(rumApi.startDurationVital).not.toHaveBeenCalled();
      expect(display.error).toHaveBeenCalledOnce();
    });

    it('rejects invalid stopDurationVital options', () => {
      stopDurationVital('checkout', { description: 42 } as never);

      expect(rumApi.stopDurationVital).not.toHaveBeenCalled();
      expect(display.error).toHaveBeenCalledOnce();
    });

    it('warns but forwards a name outside the documented backend character set', () => {
      addDurationVital('document open', { startTime: 0, duration: 1 });

      expect(rumApi.addDurationVital).toHaveBeenCalledOnce();
      expect(display.warn).toHaveBeenCalledOnce();
    });
  });
});
