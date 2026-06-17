import { describe, it, expect } from 'vitest';
import { isSessionSampled } from './Sampler';

// UUID whose last segment is 000000000000 → always the smallest possible value → always sampled
const ALWAYS_SAMPLED_UUID = '00000000-0000-0000-0000-000000000000';
// UUID whose last segment is ffffffffffff → largest possible value → never sampled
const NEVER_SAMPLED_UUID = '00000000-0000-0000-0000-ffffffffffff';

describe('isSessionSampled', () => {
  it('always returns true when sampleRate is 100', () => {
    expect(isSessionSampled(NEVER_SAMPLED_UUID, 100)).toBe(true);
    expect(isSessionSampled(ALWAYS_SAMPLED_UUID, 100)).toBe(true);
  });

  it('always returns false when sampleRate is 0', () => {
    expect(isSessionSampled(ALWAYS_SAMPLED_UUID, 0)).toBe(false);
    expect(isSessionSampled(NEVER_SAMPLED_UUID, 0)).toBe(false);
  });

  it('is deterministic — same UUID always produces the same decision', () => {
    const uuid = 'a1b2c3d4-e5f6-7890-abcd-1234567890ab';
    const first = isSessionSampled(uuid, 50);
    const second = isSessionSampled(uuid, 50);
    expect(first).toBe(second);
  });

  it('a UUID with a low last-segment value is sampled at 50%', () => {
    // last segment 000000000001 = 1, well below 50% threshold
    expect(isSessionSampled('00000000-0000-0000-0000-000000000001', 50)).toBe(true);
  });

  it('a UUID with a high last-segment value is not sampled at 50%', () => {
    // last segment fffffffffffe = max-1, well above 50% threshold
    expect(isSessionSampled('00000000-0000-0000-0000-fffffffffffe', 50)).toBe(false);
  });
});
