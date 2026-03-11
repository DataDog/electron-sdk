import { describe, it, expect } from 'vitest';
import { computeIntakeUrlForTrack } from './utils';

describe('computeIntakeUrlForTrack', () => {
  it('uses proxy when provided (proxy takes precedence)', () => {
    const result = computeIntakeUrlForTrack('datadoghq.com', 'rum', 'http://localhost:3000');

    expect(result).toBe('http://localhost:3000');
  });

  it('generates intakeUrl from site when proxy is not provided', () => {
    const result = computeIntakeUrlForTrack('datadoghq.eu', 'rum');

    expect(result).toBe('https://browser-intake-datadoghq.eu/api/v2/rum');
  });
});
