import fs from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DiskStorage } from './DiskStorage';
import { display } from './display';

vi.mock('node:fs/promises');

beforeEach(() => vi.resetAllMocks());
afterEach(() => vi.restoreAllMocks());

describe('DiskStorage', () => {
  it('loads JSON, treating missing or invalid files as absent', async () => {
    const storage = new DiskStorage<string[]>('/history');
    vi.mocked(fs.readFile).mockResolvedValueOnce('["saved"]');
    expect(await storage.load()).toEqual(['saved']);
    vi.mocked(fs.readFile).mockResolvedValueOnce('invalid');
    expect(await storage.load()).toBeUndefined();
    vi.mocked(fs.readFile).mockRejectedValueOnce(new Error('ENOENT'));
    expect(await storage.load()).toBeUndefined();
  });

  it('captures each snapshot immediately and waits for the previous write', async () => {
    const storage = new DiskStorage<string[]>('/history');
    let finish!: () => void;
    vi.mocked(fs.writeFile).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        })
    );
    vi.mocked(fs.writeFile).mockResolvedValue(undefined);
    const values = ['first'];
    storage.save(values);
    await vi.waitFor(() => expect(fs.writeFile).toHaveBeenCalledOnce());
    values.push('second');
    storage.save(values);
    values.push('unsaved');
    expect(fs.writeFile).toHaveBeenCalledOnce();
    finish();
    await vi.waitFor(() => expect(fs.writeFile).toHaveBeenCalledTimes(2));
    expect(vi.mocked(fs.writeFile).mock.calls.map((call) => call[1])).toEqual(['["first"]', '["first","second"]']);
  });

  it('reports a failed write without preventing later snapshots from being saved', async () => {
    const storage = new DiskStorage<string[]>('/history');
    const error = new Error('disk unavailable');
    vi.mocked(fs.writeFile).mockRejectedValueOnce(error).mockResolvedValue(undefined);
    const report = vi.spyOn(display, 'error').mockImplementation(() => undefined);
    storage.save(['first']);
    storage.save(['second']);
    await vi.waitFor(() => expect(fs.writeFile).toHaveBeenCalledTimes(2));
    expect(report).toHaveBeenCalledWith('Failed to persist context history:', error);
    expect(fs.writeFile).toHaveBeenLastCalledWith('/history', '["second"]', 'utf-8');
  });
});
