import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { checkProfilingQuota } from './quotaCheck';
import { createTestConfiguration } from '../../mocks.specUtil';

function mockFetchResponse(admitted: boolean, reason: string, status = admitted ? 200 : 429) {
  return vi.fn().mockResolvedValue({
    status,
    json: () => Promise.resolve({ data: { attributes: { admitted, reason } } }),
  });
}

function mockFetchUnparseable(status: number) {
  return vi.fn().mockResolvedValue({
    status,
    json: () => Promise.reject(new Error('invalid json')),
  });
}

describe('checkProfilingQuota', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('URL construction', () => {
    it('builds the correct URL for datadoghq.com', async () => {
      global.fetch = mockFetchResponse(true, 'quota_ok');
      const promise = checkProfilingQuota(
        createTestConfiguration({ site: 'datadoghq.com', clientToken: 'my-token' }),
        'session-abc'
      );
      await vi.runAllTimersAsync();
      await promise;
      expect(vi.mocked(fetch).mock.calls[0][0]).toBe(
        'https://quota.browser-intake-datadoghq.com/api/v2/profiling/quota?session_id=session-abc'
      );
    });

    it('builds the correct URL for datadoghq.eu', async () => {
      global.fetch = mockFetchResponse(true, 'quota_ok');
      const promise = checkProfilingQuota(createTestConfiguration({ site: 'datadoghq.eu' }), 'session-abc');
      await vi.runAllTimersAsync();
      await promise;
      expect(vi.mocked(fetch).mock.calls[0][0]).toBe(
        'https://quota.browser-intake-datadoghq.eu/api/v2/profiling/quota?session_id=session-abc'
      );
    });

    it('builds the correct URL for us3.datadoghq.com', async () => {
      global.fetch = mockFetchResponse(true, 'quota_ok');
      const promise = checkProfilingQuota(createTestConfiguration({ site: 'us3.datadoghq.com' }), 'session-abc');
      await vi.runAllTimersAsync();
      await promise;
      expect(vi.mocked(fetch).mock.calls[0][0]).toBe(
        'https://quota.browser-intake-us3-datadoghq.com/api/v2/profiling/quota?session_id=session-abc'
      );
    });

    it('builds the correct URL for datad0g.com (internal staging)', async () => {
      global.fetch = mockFetchResponse(true, 'quota_ok');
      const promise = checkProfilingQuota(createTestConfiguration({ site: 'datad0g.com' }), 'session-abc');
      await vi.runAllTimersAsync();
      await promise;
      expect(vi.mocked(fetch).mock.calls[0][0]).toBe(
        'https://quota.browser-intake-datad0g.com/api/v2/profiling/quota?session_id=session-abc'
      );
    });

    it('routes through proxy with ddforwardSubdomain=quota', async () => {
      global.fetch = mockFetchResponse(true, 'quota_ok');
      const promise = checkProfilingQuota(
        createTestConfiguration({ proxy: 'http://proxy.example.com' }),
        'session-abc'
      );
      await vi.runAllTimersAsync();
      await promise;
      expect(vi.mocked(fetch).mock.calls[0][0]).toBe(
        'http://proxy.example.com?ddforward=%2Fapi%2Fv2%2Fprofiling%2Fquota%3Fsession_id%3Dsession-abc&ddforwardSubdomain=quota'
      );
    });

    it('sends DD-CLIENT-TOKEN header', async () => {
      global.fetch = mockFetchResponse(true, 'quota_ok');
      const promise = checkProfilingQuota(createTestConfiguration({ clientToken: 'my-token' }), 'session-abc');
      await vi.runAllTimersAsync();
      await promise;
      const init = vi.mocked(fetch).mock.calls[0][1] as RequestInit;
      expect((init.headers as Headers).get('DD-CLIENT-TOKEN')).toBe('my-token');
    });
  });

  describe('response parsing — admitted: true', () => {
    it.each([
      ['quota_ok', 'quota_ok'],
      ['backend_unavailable', 'backend_unavailable'],
      ['org_disabled', 'org_disabled'],
    ])('returns quota_ok for reason %s', async (reason, expectedReason) => {
      global.fetch = mockFetchResponse(true, reason);
      const promise = checkProfilingQuota(createTestConfiguration(), 'sid');
      await vi.runAllTimersAsync();
      expect(await promise).toEqual({ decision: 'quota_ok', reason: expectedReason });
    });

    it('normalises backend_client_not_initialized to backend_unavailable', async () => {
      global.fetch = mockFetchResponse(true, 'backend_client_not_initialized');
      const promise = checkProfilingQuota(createTestConfiguration(), 'sid');
      await vi.runAllTimersAsync();
      expect(await promise).toEqual({ decision: 'quota_ok', reason: 'backend_unavailable' });
    });
  });

  describe('response parsing — admitted: false', () => {
    it.each([['quota_exceeded'], ['org_disabled'], ['undefined']])('returns quota_ko for reason %s', async (reason) => {
      global.fetch = mockFetchResponse(false, reason);
      const promise = checkProfilingQuota(createTestConfiguration(), 'sid');
      await vi.runAllTimersAsync();
      expect(await promise).toEqual({ decision: 'quota_ko', reason });
    });
  });

  describe('fail-open cases', () => {
    it('returns quota_ok with api-error on network error', async () => {
      global.fetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
      const promise = checkProfilingQuota(createTestConfiguration(), 'sid');
      await vi.runAllTimersAsync();
      expect(await promise).toEqual({ decision: 'quota_ok', reason: 'api-error' });
    });

    it('returns quota_ok with api-error when body is unparseable and status is 200', async () => {
      global.fetch = mockFetchUnparseable(200);
      const promise = checkProfilingQuota(createTestConfiguration(), 'sid');
      await vi.runAllTimersAsync();
      expect(await promise).toEqual({ decision: 'quota_ok', reason: 'api-error' });
    });

    it('returns quota_ko with quota_exceeded when body is unparseable and status is 429', async () => {
      global.fetch = mockFetchUnparseable(429);
      const promise = checkProfilingQuota(createTestConfiguration(), 'sid');
      await vi.runAllTimersAsync();
      expect(await promise).toEqual({ decision: 'quota_ko', reason: 'quota_exceeded' });
    });

    it('returns quota_ok with timeout reason when fetch times out', async () => {
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      global.fetch = vi.fn().mockReturnValue(new Promise(() => {})); // never resolves
      const promise = checkProfilingQuota(createTestConfiguration(), 'sid', 100);
      vi.advanceTimersByTime(100);
      expect(await promise).toEqual({ decision: 'quota_ok', reason: 'timeout' });
    });
  });
});
