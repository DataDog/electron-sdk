import { describe, it, expect } from 'vitest';
import { isSessionSampled } from './Sampler';

// UUID known to yield a low hash value using the Knuth formula (from browser-sdk)
const LOW_HASH_UUID = '29a4b5e3-9859-4290-99fa-4bc4a1a348b9';
// UUID known to yield a high hash value using the Knuth formula (from browser-sdk)
const HIGH_HASH_UUID = '5321b54a-d6ec-4b24-996d-dd70c617e09a';
// UUID chosen arbitrarily, used when the test doesn't depend on the hash value
const ARBITRARY_UUID = '1ff81c8c-6e32-473b-869b-55af08048323';
// UUID whose last segment is 000000000000 → hash is always 0 → always sampled
const ZERO_UUID = '00000000-0000-0000-0000-000000000000';

describe('isSessionSampled', () => {
  it('always returns true when sampleRate is 100', () => {
    expect(isSessionSampled(ARBITRARY_UUID, 100)).toBe(true);
  });

  it('always returns false when sampleRate is 0', () => {
    expect(isSessionSampled(ARBITRARY_UUID, 0)).toBe(false);
  });

  it('is deterministic — same UUID always produces the same decision', () => {
    const first = isSessionSampled(ARBITRARY_UUID, 50);
    const second = isSessionSampled(ARBITRARY_UUID, 50);
    expect(first).toBe(second);
  });

  it('the all-zero UUID is always sampled for any rate > 0', () => {
    expect(isSessionSampled(ZERO_UUID, 0.0001)).toBe(true);
  });

  it('a UUID with a low hash value is sampled even at very low rates', () => {
    expect(isSessionSampled(LOW_HASH_UUID, 0.1)).toBe(true);
    expect(isSessionSampled(LOW_HASH_UUID, 0.01)).toBe(true);
  });

  it('a UUID with a high hash value is not sampled even at very high rates', () => {
    expect(isSessionSampled(HIGH_HASH_UUID, 99.9)).toBe(false);
    expect(isSessionSampled(HIGH_HASH_UUID, 99.99)).toBe(false);
  });

  it('returns false for an invalid session ID', () => {
    expect(isSessionSampled('not-a-uuid', 50)).toBe(false);
    expect(isSessionSampled('', 50)).toBe(false);
  });
});
