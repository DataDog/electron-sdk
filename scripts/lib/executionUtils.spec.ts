import { describe, expect, it, vi } from 'vitest';

import { retryWithDelays } from './executionUtils.ts';

describe('retryWithDelays', () => {
  it('retries after each delay until the operation succeeds', async () => {
    const firstError = new Error('first failure');
    const secondError = new Error('second failure');
    const operation = vi
      .fn()
      .mockRejectedValueOnce(firstError)
      .mockRejectedValueOnce(secondError)
      .mockReturnValue('ok');
    const onRetry = vi.fn();

    await expect(retryWithDelays(operation, [0, 0], onRetry)).resolves.toBe('ok');

    expect(operation).toHaveBeenCalledTimes(3);
    expect(onRetry).toHaveBeenNthCalledWith(1, firstError, 2, 0);
    expect(onRetry).toHaveBeenNthCalledWith(2, secondError, 3, 0);
  });

  it('throws the final error when no retries remain', async () => {
    const finalError = new Error('still failing');
    const operation = vi.fn().mockRejectedValue(finalError);

    await expect(retryWithDelays(operation, [0])).rejects.toBe(finalError);
    expect(operation).toHaveBeenCalledTimes(2);
  });
});
