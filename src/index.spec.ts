import { describe, it, expect } from 'vitest';
import { init } from './index';

describe('init', () => {
  it('should return true', () => {
    expect(init()).toBe(true);
  });
});
