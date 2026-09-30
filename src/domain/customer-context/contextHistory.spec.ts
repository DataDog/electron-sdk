import { mockFs } from '../../mocks.specUtil';

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/mock/user/data') },
}));

vi.mock('../../tools/display', () => ({
  display: { error: vi.fn() },
}));

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { TimeStamp } from '@datadog/js-core/time';
import { initContextHistory } from './contextHistory';
import { TrackingConsentManager } from '../tracking-consent';

vi.mock('node:fs/promises');
const mfs = mockFs();

const T0 = 0 as TimeStamp;
const T10 = 10 as TimeStamp;

describe('initContextHistory', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T10);
    mfs.writeFile.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    mfs.reset();
  });

  it.each(['granted', 'pending', 'not-granted'] as const)(
    'closes the previous process active context at startup with %s consent',
    async (consent) => {
      mfs.readFile.mockResolvedValue(JSON.stringify([{ startTime: T0, endTime: null, value: { id: 'user-1' } }]));

      const manager = new TrackingConsentManager();
      manager.update(consent);
      const history = await initContextHistory('_dd_test_context_history', manager);
      await vi.advanceTimersByTimeAsync(0);

      expect(history.find(T0)).toEqual({ id: 'user-1' });
      expect(history.find((T10 + 1) as TimeStamp)).toBeUndefined();

      const lastWrite = mfs.writeFile.mock.calls[mfs.writeFile.mock.calls.length - 1] as [string, string, string];
      expect(lastWrite[0]).toBe('/mock/user/data/_dd_test_context_history');
      expect(JSON.parse(lastWrite[1])).toEqual([{ startTime: T0, endTime: T10, value: { id: 'user-1' } }]);
      history.stop();
    }
  );
});
