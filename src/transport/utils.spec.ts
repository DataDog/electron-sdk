import { describe, it, expect } from 'vitest';
import { appendIntakeParams, computeIntakeHostname, computeIntakeUrlForTrack } from './utils';

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
    expect(computeIntakeUrlForTrack('datadoghq.eu', 'rum')).toBe(
      'https://browser-intake-datadoghq.eu/api/v2/rum?ddsource=electron'
    );
  });

  it('generates intakeUrl for spans track', () => {
    expect(computeIntakeUrlForTrack('ap1.datadoghq.com', 'spans')).toBe(
      'https://browser-intake-ap1-datadoghq.com/api/v2/spans?ddsource=electron'
    );
  });

  it('uses proxy when provided, with ddforward for rum track', () => {
    expect(computeIntakeUrlForTrack('datadoghq.com', 'rum', { proxy: 'http://localhost:3000' })).toBe(
      'http://localhost:3000?ddforward=%2Fapi%2Fv2%2Frum%3Fddsource%3Delectron'
    );
  });

  it('uses proxy when provided, with ddforward for spans track', () => {
    expect(computeIntakeUrlForTrack('datadoghq.com', 'spans', { proxy: 'http://proxy:8080' })).toBe(
      'http://proxy:8080?ddforward=%2Fapi%2Fv2%2Fspans%3Fddsource%3Delectron'
    );
  });

  it('prepends subdomain and appends ddsource for quota track', () => {
    expect(computeIntakeUrlForTrack('datadoghq.com', 'profiling/quota?session_id=abc', { subdomain: 'quota' })).toBe(
      'https://quota.browser-intake-datadoghq.com/api/v2/profiling/quota?session_id=abc&ddsource=electron'
    );
  });

  it('appends ddforwardSubdomain to proxy URL when subdomain is provided', () => {
    expect(
      computeIntakeUrlForTrack('datadoghq.com', 'profiling/quota?session_id=abc', {
        proxy: 'http://proxy:8080',
        subdomain: 'quota',
      })
    ).toBe(
      'http://proxy:8080?ddforward=%2Fapi%2Fv2%2Fprofiling%2Fquota%3Fsession_id%3Dabc%26ddsource%3Delectron&ddforwardSubdomain=quota'
    );
  });
});

describe('appendIntakeParams', () => {
  it('merges params into a direct intake URL, overwriting the default ddsource', () => {
    const result = appendIntakeParams('https://browser-intake-datadoghq.com/api/v2/replay?ddsource=electron', {
      ddsource: 'browser',
      'dd-api-key': 'token',
    });

    const url = new URL(result);
    expect(url.searchParams.getAll('ddsource')).toEqual(['browser']);
    expect(url.searchParams.get('dd-api-key')).toBe('token');
    // No second '?' introduced.
    expect(result.match(/\?/g)).toHaveLength(1);
  });

  it('folds params into the forwarded path for a proxy URL, not the proxy query itself', () => {
    const proxyUrl = computeIntakeUrlForTrack('datadoghq.com', 'replay', { proxy: 'http://proxy:8080' });

    const result = appendIntakeParams(proxyUrl, { ddsource: 'browser', 'dd-api-key': 'token' });

    const url = new URL(result);
    // Auth params must not leak onto the proxy URL.
    expect(url.searchParams.get('dd-api-key')).toBeNull();
    const forwarded = new URL(url.searchParams.get('ddforward')!, 'https://placeholder.invalid');
    expect(forwarded.pathname).toBe('/api/v2/replay');
    expect(forwarded.searchParams.getAll('ddsource')).toEqual(['browser']);
    expect(forwarded.searchParams.get('dd-api-key')).toBe('token');
  });
});
