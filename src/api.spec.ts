import { beforeEach, describe, expect, it, vi } from 'vitest';

const { display, rumApi, globalContextApi } = vi.hoisted(() => ({
  display: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
  rumApi: {
    addDurationVital: vi.fn(),
    startDurationVital: vi.fn(),
    stopDurationVital: vi.fn(),
  },
  globalContextApi: {
    getContext: vi.fn(() => ({})),
    setContext: vi.fn(),
    setProperty: vi.fn(),
    removeProperty: vi.fn(),
    clearContext: vi.fn(),
  },
}));

vi.mock('./domain/telemetry', () => ({
  callMonitored: (callback: () => unknown) => callback(),
}));
vi.mock('./tools/display', () => ({ display }));

import {
  addDurationVital,
  clearGlobalContext,
  getGlobalContext,
  removeGlobalContextProperty,
  setDurationVitalApi,
  setGlobalContext,
  setGlobalContextApi,
  setGlobalContextProperty,
  startDurationVital,
  stopDurationVital,
} from './api';

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

describe.sequential('global context public API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setGlobalContextApi(globalContextApi);
  });

  describe('before initialization', () => {
    it('does not throw and reports nothing', () => {
      setGlobalContextApi(undefined);

      expect(() => {
        setGlobalContext({ team: 'checkout' });
        setGlobalContextProperty('build', '1.2.3');
        removeGlobalContextProperty('build');
        clearGlobalContext();
      }).not.toThrow();
      expect(getGlobalContext()).toEqual({});
      expect(display.error).not.toHaveBeenCalled();
    });
  });

  describe('setGlobalContext', () => {
    it('forwards a sanitized copy of the context', () => {
      setGlobalContext({ team: 'checkout' });

      expect(globalContextApi.setContext).toHaveBeenCalledWith({ team: 'checkout' });
    });

    it('is rejected when the context is not an object', () => {
      setGlobalContext('nope' as never);

      expect(globalContextApi.setContext).not.toHaveBeenCalled();
      expect(display.error).toHaveBeenCalledOnce();
    });

    it('drops values that cannot be serialized rather than forwarding them', () => {
      const circular: Record<string, unknown> = { team: 'checkout' };
      circular.self = circular;

      setGlobalContext(circular);

      const forwarded = globalContextApi.setContext.mock.calls[0][0] as Record<string, unknown>;
      expect(forwarded.team).toBe('checkout');
      expect(() => JSON.stringify(forwarded)).not.toThrow();
    });
  });

  describe('setGlobalContextProperty', () => {
    it('forwards the key and value', () => {
      setGlobalContextProperty('build', '1.2.3');

      expect(globalContextApi.setProperty).toHaveBeenCalledWith('build', '1.2.3');
    });

    it.each(['', '   '])('is rejected for a blank key %j', (key) => {
      setGlobalContextProperty(key, 'v');

      expect(globalContextApi.setProperty).not.toHaveBeenCalled();
      expect(display.error).toHaveBeenCalledOnce();
    });
  });

  describe('removeGlobalContextProperty', () => {
    it('forwards the key', () => {
      removeGlobalContextProperty('build');

      expect(globalContextApi.removeProperty).toHaveBeenCalledWith('build');
    });

    it('is rejected for a blank key', () => {
      removeGlobalContextProperty('  ');

      expect(globalContextApi.removeProperty).not.toHaveBeenCalled();
      expect(display.error).toHaveBeenCalledOnce();
    });
  });

  describe('clearGlobalContext', () => {
    it('delegates to the context store', () => {
      clearGlobalContext();

      expect(globalContextApi.clearContext).toHaveBeenCalledOnce();
    });
  });

  describe('getGlobalContext', () => {
    it('returns what the context store reports', () => {
      globalContextApi.getContext.mockReturnValueOnce({ team: 'checkout' });

      expect(getGlobalContext()).toEqual({ team: 'checkout' });
    });
  });
});
