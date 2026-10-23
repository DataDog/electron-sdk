import { describe, it, expect, vi } from 'vitest';
import { monitorInstrumentation } from './monitorInstrumentation';

// Uses the real callMonitored from browser-core (via ./Telemetry). Without
// telemetry init it simply runs the callback and swallows any thrown error, which is exactly the
// behavior these tests rely on.

describe('monitorInstrumentation', () => {
  it('runs before and onResult with the original result on success', () => {
    const onResult = vi.fn();
    const before = vi.fn((hooks: { onResult: (cb: (r: number) => void) => void }) => {
      hooks.onResult(onResult);
    });

    const result = monitorInstrumentation<number>(before, () => 42);

    expect(before).toHaveBeenCalledTimes(1);
    expect(result).toBe(42);
    expect(onResult).toHaveBeenCalledWith(42);
  });

  it('passes the original return value through unchanged', () => {
    const value = { some: 'object' };
    const result = monitorInstrumentation<typeof value>(
      () => undefined,
      () => value
    );
    expect(result).toBe(value);
  });

  it('runs onError then rethrows when invokeOriginal throws synchronously', () => {
    const err = new Error('boom');
    const onError = vi.fn();
    const onResult = vi.fn();

    expect(() =>
      monitorInstrumentation<number>(
        ({ onError: registerError, onResult: registerResult }) => {
          registerError(onError);
          registerResult(onResult);
        },
        () => {
          throw err;
        }
      )
    ).toThrow(err);

    expect(onError).toHaveBeenCalledWith(err);
    expect(onResult).not.toHaveBeenCalled();
  });

  it('no-ops gracefully and still runs the original when before throws before registering hooks', () => {
    const invokeOriginal = vi.fn(() => 'value');

    const result = monitorInstrumentation<string>(() => {
      throw new Error('before failed');
    }, invokeOriginal);

    expect(invokeOriginal).toHaveBeenCalledTimes(1);
    expect(result).toBe('value');
  });

  it('still rethrows the original error even when before failed to register onError', () => {
    const err = new Error('original boom');
    expect(() =>
      monitorInstrumentation<number>(
        () => {
          throw new Error('before failed');
        },
        () => {
          throw err;
        }
      )
    ).toThrow(err);
  });

  it('does not run onResult when onError path is taken', () => {
    const onResult = vi.fn();
    expect(() =>
      monitorInstrumentation<number>(
        ({ onResult: registerResult }) => registerResult(onResult),
        () => {
          throw new Error('boom');
        }
      )
    ).toThrow();
    expect(onResult).not.toHaveBeenCalled();
  });
});
