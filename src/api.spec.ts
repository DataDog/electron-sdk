import { beforeEach, describe, expect, it, vi } from 'vitest';

const { addUsage, display, rumApi, globalContextApi } = vi.hoisted(() => ({
  addUsage: vi.fn(),
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
  addUsage,
  callMonitored: (callback: () => unknown) => callback(),
}));
vi.mock('./tools/display', () => ({ display }));

import type { TrackingConsent } from './domain/tracking-consent';

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

  describe('usage telemetry', () => {
    it('reports the feature used by each duration vital API', () => {
      addDurationVital('database.migration', { startTime: 0, duration: 1 });
      startDurationVital('document.open');
      stopDurationVital('document.open');

      expect(addUsage.mock.calls.flat()).toEqual([
        { feature: 'add-duration-vital' },
        { feature: 'start-duration-vital' },
        { feature: 'stop-duration-vital' },
      ]);
    });

    it('reports usage of a call rejected by validation', () => {
      addDurationVital('', { startTime: 0, duration: 1 });

      expect(rumApi.addDurationVital).not.toHaveBeenCalled();
      expect(addUsage).toHaveBeenCalledWith({ feature: 'add-duration-vital' });
    });
  });
});

describe.sequential('global context public API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setGlobalContextApi(globalContextApi);
  });

  describe('before initialization', () => {
    it('does not throw or report an error', () => {
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

    it('drops invalid top-level keys while preserving the rest of the context', () => {
      setGlobalContext({ team: 'checkout', '  ': 'blank', ' padded ': 'value' });

      expect(globalContextApi.setContext).toHaveBeenCalledWith({ team: 'checkout' });
      expect(display.error).toHaveBeenCalledTimes(2);
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

    it.each(['', '   ', ' build '])('is rejected for an invalid key %j', (key) => {
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

    it.each(['  ', ' build '])('is rejected for an invalid key %j', (key) => {
      removeGlobalContextProperty(key);

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

  describe('usage telemetry', () => {
    it('reports the feature used by each global context API', () => {
      setGlobalContext({ team: 'checkout' });
      getGlobalContext();
      setGlobalContextProperty('build', '1.2.3');
      removeGlobalContextProperty('build');
      clearGlobalContext();

      expect(addUsage.mock.calls.flat()).toEqual([
        { feature: 'set-global-context' },
        { feature: 'get-global-context' },
        { feature: 'set-global-context-property' },
        { feature: 'remove-global-context-property' },
        { feature: 'clear-global-context' },
      ]);
    });

    it('reports usage of a call rejected by validation', () => {
      setGlobalContextProperty('', 'value');

      expect(globalContextApi.setProperty).not.toHaveBeenCalled();
      expect(addUsage).toHaveBeenCalledWith({ feature: 'set-global-context-property' });
    });
  });
});

describe.sequential('tracking consent public API', () => {
  let api: typeof import('./api');
  const manager = { update: vi.fn() };

  beforeEach(async () => {
    vi.clearAllMocks();
    // The consent last set by the app is module state: each test starts from a fresh module.
    vi.resetModules();
    api = await import('./api');
  });

  it('updates the registered manager directly', () => {
    api.setTrackingConsentApi(manager);

    api.setTrackingConsent('pending');

    expect(manager.update).toHaveBeenCalledExactlyOnceWith('pending');
  });

  it('reports usage after applying the consent', () => {
    api.setTrackingConsentApi(manager);

    api.setTrackingConsent('granted');

    expect(addUsage).toHaveBeenCalledExactlyOnceWith({ feature: 'set-tracking-consent', tracking_consent: 'granted' });
    expect(manager.update.mock.invocationCallOrder[0]).toBeLessThan(addUsage.mock.invocationCallOrder[0]);
  });

  it('handles an invalid consent as a refusal', () => {
    api.setTrackingConsentApi(manager);

    api.setTrackingConsent('denied' as never);

    expect(display.error).toHaveBeenCalledExactlyOnceWith(
      'setTrackingConsent: consent must be one of: granted, pending, not-granted. It is handled as not-granted.'
    );
    expect(manager.update).toHaveBeenCalledExactlyOnceWith('not-granted');
    expect(addUsage).toHaveBeenCalledExactlyOnceWith({
      feature: 'set-tracking-consent',
      tracking_consent: 'not-granted',
    });
  });

  it.each<[string, TrackingConsent[], TrackingConsent]>([
    ['a consent set', ['not-granted'], 'not-granted'],
    ['the last consent set', ['not-granted', 'granted'], 'granted'],
    ['a refusal for an invalid consent set', ['denied' as never], 'not-granted'],
  ])('applies %s before init() to the manager it registers', (_title, calls, expected) => {
    calls.forEach((consent) => api.setTrackingConsent(consent));

    api.setTrackingConsentApi(manager);

    expect(manager.update).toHaveBeenCalledExactlyOnceWith(expected);
  });

  it('leaves the init option when no consent was set', () => {
    api.setTrackingConsentApi(manager);

    expect(manager.update).not.toHaveBeenCalled();
  });

  it.each<[string, () => void]>([
    [
      'before a failed init()',
      () => {
        api.setTrackingConsent('not-granted');
        api.setTrackingConsentApi(manager);
      },
    ],
    [
      'after a failed init() registered its manager',
      () => {
        api.setTrackingConsentApi(manager);
        api.setTrackingConsent('not-granted');
      },
    ],
  ])('applies a consent set %s to the manager of the retried init()', (_title, failedInit) => {
    failedInit();
    const retriedManager = { update: vi.fn() };

    api.setTrackingConsentApi(retriedManager);

    expect(retriedManager.update).toHaveBeenCalledExactlyOnceWith('not-granted');
  });
});
