import { describe, it, expect } from 'vitest';
import {
  normalizeFlagsContext,
  FLAGS_MAX_ATTRIBUTES,
  FLAGS_MAX_ATTRIBUTE_KEY_LENGTH,
  FLAGS_MAX_ATTRIBUTE_STRING_LENGTH,
} from './flagsContext';

describe('normalizeFlagsContext', () => {
  it('keeps flat string, number and boolean attributes', () => {
    const { context, droppedKeys } = normalizeFlagsContext(
      { targetingKey: 'user-1', plan: 'pro', seats: 12, beta: true },
      'anon'
    );
    expect(context).toEqual({ targetingKey: 'user-1', plan: 'pro', seats: 12, beta: true });
    expect(droppedKeys).toEqual([]);
  });

  it('drops nested objects, arrays, null and non-finite numbers and reports their keys', () => {
    const { context, droppedKeys } = normalizeFlagsContext(
      {
        targetingKey: 'user-1',
        nested: { a: 1 },
        list: [1, 2],
        nothing: null,
        infinite: Number.POSITIVE_INFINITY,
        nan: Number.NaN,
      },
      'anon'
    );
    expect(context).toEqual({ targetingKey: 'user-1' });
    expect(droppedKeys).toEqual(['nested', 'list', 'nothing', 'infinite', 'nan']);
  });

  it('enforces the attribute count, key length and string length limits and reports dropped keys', () => {
    const tooManyAttributes: Record<string, string> = {};
    for (let i = 0; i < FLAGS_MAX_ATTRIBUTES + 5; i += 1) {
      tooManyAttributes[`attr-${i}`] = `value-${i}`;
    }
    const { context, droppedKeys } = normalizeFlagsContext(
      {
        targetingKey: 'user-1',
        ...tooManyAttributes,
        ['x'.repeat(FLAGS_MAX_ATTRIBUTE_KEY_LENGTH + 1)]: 'ok',
        longValue: 'y'.repeat(FLAGS_MAX_ATTRIBUTE_STRING_LENGTH + 1),
      },
      'anon'
    );
    const keptAttributeCount = Object.keys(context).filter((key) => key !== 'targetingKey').length;
    expect(keptAttributeCount).toBe(FLAGS_MAX_ATTRIBUTES);
    expect(droppedKeys).toContain('x'.repeat(FLAGS_MAX_ATTRIBUTE_KEY_LENGTH + 1));
    expect(droppedKeys).toContain('longValue');
    expect(droppedKeys).toHaveLength(7); // 5 attributes over the count limit + the long key + the long value
  });

  it('uses the anonymous key when targetingKey is missing, empty or not a string', () => {
    expect(normalizeFlagsContext({}, 'anon-key').context.targetingKey).toBe('anon-key');
    expect(normalizeFlagsContext({ targetingKey: '' }, 'anon-key').context.targetingKey).toBe('anon-key');
    expect(normalizeFlagsContext({ targetingKey: 42 }, 'anon-key').context.targetingKey).toBe('anon-key');
    expect(normalizeFlagsContext({ targetingKey: 42 }, 'anon-key').droppedKeys).toEqual(['targetingKey']);
  });

  it('replaces rather than merges a previous context', () => {
    const first = normalizeFlagsContext({ targetingKey: 'user-1', plan: 'pro', region: 'us' }, 'anon');
    const second = normalizeFlagsContext({ targetingKey: 'user-2' }, 'anon');
    expect(second.context).toEqual({ targetingKey: 'user-2' });
    expect(second.context).not.toHaveProperty('plan');
    expect(first.context).toHaveProperty('plan');
  });
  it('falls back to the anonymous key when targetingKey exceeds the string length limit and reports it', () => {
    const { context, droppedKeys } = normalizeFlagsContext(
      { targetingKey: 'k'.repeat(FLAGS_MAX_ATTRIBUTE_STRING_LENGTH + 1), plan: 'pro' },
      'anon'
    );
    expect(context).toEqual({ targetingKey: 'anon', plan: 'pro' });
    expect(droppedKeys).toEqual(['targetingKey']);
  });
});
