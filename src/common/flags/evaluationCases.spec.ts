import { describe, it, expect } from 'vitest';
import { CASES, oracle } from './evaluationCases.specUtil';

describe('evaluation fixture guards', () => {
  // These guard the fixture itself: if the hand-authored configuration degenerates
  // (every case returning the default), the parity table would be vacuous.

  it('oracle returns a non-default variant for pro and a different one for free', () => {
    const pro = oracle(CASES[0]);
    const free = oracle(CASES[1]);
    expect(pro.value).toBe('variant-a');
    expect(free.value).toBe('str-default');
  });

  it('oracle buckets the two split keys into different variants', () => {
    const key1 = oracle(CASES[2]);
    const key5 = oracle(CASES[3]);
    expect(key1.value).not.toBe(key5.value);
    expect(key1.variant).not.toBe(key5.variant);
  });

  it('oracle returns the application default for the disabled flag and doLog false for the unlogged flag', () => {
    const disabled = oracle(CASES[4]);
    expect(disabled.value).toBe(true);
    expect(disabled.reason).toBe('DEFAULT');
    const unlogged = oracle(CASES[5]);
    expect(unlogged.flagMetadata.doLog).toBe(false);
  });
});
