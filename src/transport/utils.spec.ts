import { describe, it, expect } from 'vitest';
import { computeIntakeUrlForTrack } from './utils';

describe('computeIntakeUrlForTrack', () => {
  it('generates intakeUrl for rum track', () => {
    const result = computeIntakeUrlForTrack('datadoghq.eu', 'rum');

    expect(result).toBe('https://browser-intake-datadoghq.eu/api/v2/rum');
  });

  it('generates intakeUrl for spans track', () => {
    const result = computeIntakeUrlForTrack('ap1.datadoghq.com', 'spans');

    expect(result).toBe('https://browser-intake-ap1-datadoghq.com/api/v2/spans');
  });

  it('uses proxy when provided, with ddforward for rum track', () => {
    const result = computeIntakeUrlForTrack('datadoghq.com', 'rum', 'http://localhost:3000');

    expect(result).toBe('http://localhost:3000?ddforward=%2Fapi%2Fv2%2Frum');
  });

  it('uses proxy when provided, with ddforward for spans track', () => {
    const result = computeIntakeUrlForTrack('datadoghq.com', 'spans', 'http://proxy:8080');

    expect(result).toBe('http://proxy:8080?ddforward=%2Fapi%2Fv2%2Fspans');
  });
});
