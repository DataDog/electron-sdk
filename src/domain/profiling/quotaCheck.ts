import { setTimeout, clearTimeout } from '@datadog/browser-core';
import { ONE_SECOND } from '@datadog/js-core/time';
import type { Configuration } from '../../config';
import { monitor } from '../telemetry';
import { computeIntakeUrlForTrack } from '../../transport';

const QUOTA_CHECK_TIMEOUT_MS = 5 * ONE_SECOND;

export type BackendQuotaReason = 'quota_ok' | 'quota_exceeded' | 'org_disabled' | 'backend_unavailable' | 'undefined';
export type FrontendQuotaReason = 'timeout' | 'api-error';
export type QuotaReason = BackendQuotaReason | FrontendQuotaReason;

export interface QuotaResult {
  decision: 'quota_ok' | 'quota_ko';
  reason: QuotaReason;
}

function buildQuotaUrl(config: Configuration, sessionId: string): string {
  return computeIntakeUrlForTrack(config.site, `profiling/quota?session_id=${sessionId}`, {
    proxy: config.proxy,
    subdomain: 'quota',
  });
}

interface QuotaResponseBody {
  data?: {
    attributes?: {
      admitted?: unknown;
      reason?: unknown;
    };
  };
}

function parseQuotaResult(body: unknown, httpStatusFallback: QuotaResult): QuotaResult {
  const attrs = (body as QuotaResponseBody)?.data?.attributes;
  if (!attrs || typeof attrs.admitted !== 'boolean' || typeof attrs.reason !== 'string') {
    return httpStatusFallback;
  }
  const reason: BackendQuotaReason =
    attrs.reason === 'backend_client_not_initialized' ? 'backend_unavailable' : (attrs.reason as BackendQuotaReason);
  return {
    decision: attrs.admitted ? 'quota_ok' : 'quota_ko',
    reason,
  };
}

export function checkProfilingQuota(
  config: Configuration,
  sessionId: string,
  timeoutMs = QUOTA_CHECK_TIMEOUT_MS
): Promise<QuotaResult> {
  const url = buildQuotaUrl(config, sessionId);
  const controller = new AbortController();

  let timeoutId: ReturnType<typeof setTimeout>;

  const fetchPromise = fetch(url, {
    credentials: 'omit',
    signal: controller.signal,
    headers: new Headers({ 'DD-CLIENT-TOKEN': config.clientToken }),
  })
    .then(
      monitor((response: Response) => {
        const statusFallback: QuotaResult =
          response.status === 429
            ? { decision: 'quota_ko', reason: 'quota_exceeded' }
            : { decision: 'quota_ok', reason: 'api-error' };
        return response.json().then(
          monitor((body: unknown): QuotaResult => {
            clearTimeout(timeoutId);
            return parseQuotaResult(body, statusFallback);
          }),
          monitor((): QuotaResult => {
            clearTimeout(timeoutId);
            return statusFallback;
          })
        );
      })
    )
    .catch(
      monitor((): QuotaResult => {
        clearTimeout(timeoutId);
        return { decision: 'quota_ok', reason: 'api-error' };
      })
    );

  const timeoutPromise = new Promise<QuotaResult>((resolve) => {
    timeoutId = setTimeout(
      monitor(() => {
        controller.abort();
        resolve({ decision: 'quota_ok', reason: 'timeout' });
      }),
      timeoutMs
    );
  });

  return Promise.race([fetchPromise, timeoutPromise]);
}
