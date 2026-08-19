import { describe, it, expect } from 'vitest';
import { withIpcContext, computeChildParentIds } from './ipcParentContext';

describe('ipcParentContext', () => {
  it('returns an empty array when no context is active', () => {
    expect(computeChildParentIds()).toEqual([]);
  });

  it('appends the active id to its own parentIds while inside withIpcContext', () => {
    withIpcContext('call-A', [], () => {
      expect(computeChildParentIds()).toEqual(['call-A']);
    });
  });

  it('accumulates parentIds across nested withIpcContext calls', () => {
    withIpcContext('call-A', [], () => {
      withIpcContext('call-B', computeChildParentIds(), () => {
        expect(computeChildParentIds()).toEqual(['call-A', 'call-B']);
      });
    });
  });

  it('restores the previous context after the synchronous callback returns', () => {
    withIpcContext('call-A', [], () => {
      withIpcContext('call-B', ['call-A'], () => undefined);
      expect(computeChildParentIds()).toEqual(['call-A']);
    });
    expect(computeChildParentIds()).toEqual([]);
  });

  it('restores the previous context even if the callback throws', () => {
    expect(() =>
      withIpcContext('call-A', [], () => {
        throw new Error('boom');
      })
    ).toThrow('boom');
    expect(computeChildParentIds()).toEqual([]);
  });

  it('returns whatever the callback returns', () => {
    const result = withIpcContext('call-A', [], () => 42);
    expect(result).toBe(42);
  });

  it('does not persist context past an await inside an async callback (documented limitation)', async () => {
    let duringAwait: string[] | undefined;
    await withIpcContext('call-A', [], async () => {
      await Promise.resolve();
      duringAwait = computeChildParentIds();
    });
    expect(duringAwait).toEqual([]);
  });
});
