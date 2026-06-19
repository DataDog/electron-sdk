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

    expect(result).toBe('https://browser-intake-datadoghq.eu/api/v2/rum');
  });

  it('generates intakeUrl for spans track', () => {
    const result = computeIntakeUrlForTrack('ap1.datadoghq.com', 'spans');

    expect(result).toBe('https://browser-intake-ap1-datadoghq.com/api/v2/spans');
  });

  it('uses proxy when provided, with ddforward for rum track', () => {
    const result = computeIntakeUrlForTrack('datadoghq.com', 'rum', { proxy: 'http://localhost:3000' });

    expect(result).toBe('http://localhost:3000?ddforward=%2Fapi%2Fv2%2Frum');
  });

  it('uses proxy when provided, with ddforward for spans track', () => {
    const result = computeIntakeUrlForTrack('datadoghq.com', 'spans', { proxy: 'http://proxy:8080' });

    expect(result).toBe('http://proxy:8080?ddforward=%2Fapi%2Fv2%2Fspans');
  });

  it('prepends subdomain to the intake hostname when subdomain is provided', () => {
    const result = computeIntakeUrlForTrack('datadoghq.com', 'profiling/quota?session_id=abc', { subdomain: 'quota' });

    expect(result).toBe('https://quota.browser-intake-datadoghq.com/api/v2/profiling/quota?session_id=abc');
  });

  it('appends ddforwardSubdomain to proxy URL when subdomain is provided', () => {
    const result = computeIntakeUrlForTrack('datadoghq.com', 'profiling/quota?session_id=abc', {
      proxy: 'http://proxy:8080',
      subdomain: 'quota',
    });

    expect(result).toBe(
      'http://proxy:8080?ddforward=%2Fapi%2Fv2%2Fprofiling%2Fquota%3Fsession_id%3Dabc&ddforwardSubdomain=quota'
    );
  });
});
