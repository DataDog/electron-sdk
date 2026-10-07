import * as fs from 'node:fs/promises';
import type { TimeStamp } from '@datadog/js-core/time';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { display } from '../../tools/display';
import { ConsentHistoryStorage } from './ConsentHistoryStorage';

vi.mock('node:fs/promises');

describe('ConsentHistoryStorage', () => {
  const storage = new ConsentHistoryStorage('/history');

  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(display, 'error').mockImplementation(() => undefined);
    vi.mocked(fs.writeFile).mockResolvedValue(undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  it('closes the previous open interval at the next launch boundary', async () => {
    vi.mocked(fs.readFile).mockResolvedValue(
      JSON.stringify([
        { startTime: 20, endTime: null, value: 'granted' },
        { startTime: 10, endTime: 20, value: 'pending' },
      ])
    );

    expect(await storage.load(30 as TimeStamp)).toEqual([
      { startTime: 20, endTime: 30, value: 'granted' },
      { startTime: 10, endTime: 20, value: 'pending' },
    ]);
  });

  it.each([
    'not JSON',
    '{}',
    '[null]',
    '[{"startTime":0,"endTime":null,"value":"unknown"}]',
    '[{"startTime":null,"endTime":null,"value":"granted"}]',
    '[{"startTime":40,"endTime":null,"value":"granted"}]',
    '[{"startTime":20,"endTime":10,"value":"granted"}]',
    '[{"startTime":20,"endTime":null,"value":"granted"},{"startTime":0,"endTime":null,"value":"pending"}]',
    '[{"startTime":20,"endTime":null,"value":"granted"},{"startTime":10,"endTime":21,"value":"pending"}]',
    '[{"startTime":20,"endTime":null,"value":"granted"},{"startTime":10,"endTime":15,"value":"pending"}]',
  ])('rejects invalid history %s', async (stored) => {
    vi.mocked(fs.readFile).mockResolvedValue(stored);
    expect(await storage.load(30 as TimeStamp)).toEqual([]);
    expect(display.error).toHaveBeenCalledOnce();
  });

  it('treats a missing file as empty without reporting an error', async () => {
    vi.mocked(fs.readFile).mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }));
    expect(await storage.load(30 as TimeStamp)).toEqual([]);
    expect(display.error).not.toHaveBeenCalled();
  });

  it('captures immutable snapshots and serializes writes', async () => {
    const storage = new ConsentHistoryStorage('/history');
    let finish!: () => void;
    vi.mocked(fs.writeFile).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        })
    );
    const entries = [{ startTime: 10 as TimeStamp, endTime: Infinity as TimeStamp, value: 'granted' as const }];
    storage.save(entries);
    await Promise.resolve();
    entries[0].endTime = 20 as TimeStamp;
    storage.save(entries);
    expect(fs.writeFile).toHaveBeenCalledOnce();

    finish();
    await storage.flush();

    expect(vi.mocked(fs.writeFile).mock.calls.map((call) => JSON.parse(call[1] as string) as unknown)).toEqual([
      [{ startTime: 10, endTime: null, value: 'granted' }],
      [{ startTime: 10, endTime: 20, value: 'granted' }],
    ]);
  });

  it('reports write failure and allows later snapshots to persist', async () => {
    const storage = new ConsentHistoryStorage('/history');
    const error = new Error('disk unavailable');
    vi.mocked(fs.writeFile).mockRejectedValueOnce(error);
    storage.save([{ startTime: 10 as TimeStamp, endTime: Infinity as TimeStamp, value: 'pending' }]);
    storage.save([{ startTime: 20 as TimeStamp, endTime: Infinity as TimeStamp, value: 'not-granted' }]);

    await storage.flush();

    expect(display.error).toHaveBeenCalledExactlyOnceWith('Failed to persist tracking consent history:', error);
    expect(fs.writeFile).toHaveBeenLastCalledWith(
      '/history/_dd_tracking_consent_history',
      '[{"startTime":20,"endTime":null,"value":"not-granted"}]',
      'utf-8'
    );
  });
});
