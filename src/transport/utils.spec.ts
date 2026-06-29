import { describe, it, expect } from 'vitest';
import { computeIntakeHostname, computeIntakeUrlForTrack } from './utils';

describe('computeIntakeHostname', () => {
  it('returns the intake hostname for a simple site', () => {
    expect(computeIntakeHostname('datadoghq.com')).toBe('browser-intake-datadoghq.com');
  });

  it('normalizes subdomain sites', () => {
    expect(computeIntakeHostname('us3.datadoghq.com')).toBe('browser-intake-us3-datadoghq.com');
  });

  it('returns the proxy hostname when proxy is set', () => {
    expect(computeIntakeHostname('datadoghq.com', 'http://localhost:9999/api')).toBe('localhost');
  });
});

describe('computeIntakeUrlForTrack', () => {
  it('generates intakeUrl for rum track', () => {
    const result = computeIntakeUrlForTrack('datadoghq.eu', 'rum');

    expect(result).toBe('https://browser-intake-datadoghq.eu/api/v2/rum?ddsource=electron');
  });

  it('generates intakeUrl for spans track', () => {
    const result = computeIntakeUrlForTrack('ap1.datadoghq.com', 'spans');

    expect(result).toBe('https://browser-intake-ap1-datadoghq.com/api/v2/spans?ddsource=electron');
  });

  it('uses proxy when provided, with ddforward for rum track', () => {
    const result = computeIntakeUrlForTrack('datadoghq.com', 'rum', 'http://localhost:3000');

    expect(result).toBe('http://localhost:3000?ddforward=%2Fapi%2Fv2%2Frum%3Fddsource%3Delectron');
  });

  it('uses proxy when provided, with ddforward for spans track', () => {
    const result = computeIntakeUrlForTrack('datadoghq.com', 'spans', 'http://proxy:8080');

    expect(result).toBe('http://proxy:8080?ddforward=%2Fapi%2Fv2%2Fspans%3Fddsource%3Delectron');
  });
});
