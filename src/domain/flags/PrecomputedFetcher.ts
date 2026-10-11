import { configurationFromString, configurationToString, fetchPrecomputedConfiguration } from '@datadog/openfeature-browser/rules-based';
import type { FlagsConfiguration } from '@datadog/flagging-core';
import type { TimeStamp } from '@datadog/js-core/time';
import { timeStampNow } from '@datadog/js-core/time';
import {
  addError as addTelemetryError,
  callMonitored,
  clearTimeout as sdkClearTimeout,
  monitor,
  setTimeout as sdkSetTimeout,
} from '../telemetry';
import { display } from '../../tools/display';
import type { FlatContext } from '../../common/flags/types';
import { MAX_CONFIGURATION_LENGTH } from './RulesFetcher';

export type PrecomputedFetchOutcome =
  | { kind: 'success'; wire: string; fetchedAt: TimeStamp; createdAt: string }
  | { kind: 'warm-failure' }
  | { kind: 'authoritative-failure' }
  | { kind: 'oversize' }
  | { kind: 'superseded' };

export interface PrecomputedFetcherOptions {
  clientToken: string;
  site: string;
  env: string;
  applicationId?: string;
  flaggingProxy?: string;
  /** Milliseconds after which an in-flight fetch is aborted. */
  fetchTimeout: number;
  /** Maximum serialized configuration length; longer responses count as a failed fetch (D15). */
  maxConfigurationLength: number;
  fetch?: typeof globalThis.fetch;
}

/**
 * Fetches the precomputed flag assignments for an evaluation context (M7), classifies
 * failures and sequences concurrent requests so an older response never replaces a
 * newer one (a newer context aborts the in-flight fetch, D25).
 *
 * Failure classes (D27):
 * - *authoritative*: the source states assignments are unavailable (HTTP 4xx or a
 *   `precomputedError` response, e.g. the feature is not enabled for the environment).
 *   Surfaced once per failure streak through an actionable `display.error`; the owner
 *   drops the served configuration.
 * - *warm transient*: timeout, network error, HTTP 5xx or an undecodable response. The
 *   owner keeps serving the held assignments for the same context.
 */
export class PrecomputedFetcher {
  private latestRequestId = 0;
  private activeController?: AbortController;
  private loggedWarmFailure = false;
  private loggedAuthoritativeFailure = false;
  private loggedOversize = false;

  constructor(private readonly options: PrecomputedFetcherOptions) {}

  fetch(context: FlatContext): Promise<PrecomputedFetchOutcome> {
    const requestId = ++this.latestRequestId;
    const controller = new AbortController();
    this.activeController = controller;
    const timeoutId = sdkSetTimeout(() => controller.abort(), this.options.fetchTimeout);
    // The upstream fetch throws a plain Error on HTTP failures: record the status of
    // the assignments response here so failures can be classified (D27).
    const responseStatus = { status: undefined as number | undefined };
    const recordingFetch: typeof globalThis.fetch = (input, init) => {
      const fetchImplementation = this.options.fetch ?? globalThis.fetch;
      return fetchImplementation(input, init).then((response: Response) => {
        // Not wrapped in monitor: a throw here would lose the response for the upstream code.
        responseStatus.status = response.status;
        return response;
      });
    };

    const fetchOptions: Parameters<typeof fetchPrecomputedConfiguration>[0] = {
      clientToken: this.options.clientToken,
      site: this.options.site,
      env: this.options.env,
      context,
      fetch: recordingFetch,
      signal: controller.signal,
      ...(this.options.applicationId !== undefined ? { applicationId: this.options.applicationId } : {}),
      ...(this.options.flaggingProxy !== undefined ? { flaggingProxy: this.options.flaggingProxy } : {}),
    };
    return this.callUpstreamFetch(fetchOptions)
      .then(
        (configuration) => callMonitored(() => this.classifyConfiguration(configuration)) ?? WARM_FAILURE,
        (error: unknown) => callMonitored(() => classifyFetchError(error, responseStatus.status)) ?? WARM_FAILURE
      )
      .then((outcome): PrecomputedFetchOutcome => {
        if (requestId !== this.latestRequestId) {
          return { kind: 'superseded' };
        }
        callMonitored(() => this.applyOutcomeSideEffects(outcome));
        return outcome;
      })
      .finally(
        monitor(() => {
          if (this.activeController === controller) {
            this.activeController = undefined;
          }
          sdkClearTimeout(timeoutId);
        })
      );
  }

  /**
   * `fetchPrecomputedConfiguration` builds the endpoint URL synchronously and throws for
   * unsupported sites; treat that as an authoritative, actionable failure instead of a
   * host-escaping sync throw.
   */
  private callUpstreamFetch(
    fetchOptions: Parameters<typeof fetchPrecomputedConfiguration>[0]
  ): Promise<FlagsConfiguration> {
    try {
      return fetchPrecomputedConfiguration(fetchOptions);
    } catch (error) {
      addTelemetryError(error);
      display.error(
        'Feature flags assignments are not available for this environment: the configured Datadog site does not support them.'
      );
      return Promise.resolve({ precomputedError: 'unsupported site' });
    }
  }

  /**
   * Classify a fetched configuration: a `precomputedError` is the source stating
   * assignments are unavailable (authoritative). A usable configuration is serialized
   * with the wire function every process parses, checked against the size limit and the
   * round trip.
   */
  private classifyConfiguration(configuration: FlagsConfiguration): PrecomputedFetchOutcome {
    if (configuration.precomputedError !== undefined) {
      return { kind: 'authoritative-failure' };
    }
    const precomputed = configuration.precomputed;
    if (precomputed === undefined) {
      return WARM_FAILURE;
    }
    let wire: string;
    try {
      wire = configurationToString(configuration);
    } catch (error) {
      // Serializing a fetched configuration is SDK code: report it, keep serving.
      addTelemetryError(error);
      return WARM_FAILURE;
    }
    if (wire.length > this.options.maxConfigurationLength) {
      return { kind: 'oversize' };
    }
    if (configurationFromString(wire).precomputed === undefined) {
      return WARM_FAILURE;
    }
    return {
      kind: 'success',
      wire,
      fetchedAt: precomputed.fetchedAt ?? timeStampNow(),
      createdAt: precomputed.response.data.attributes.createdAt,
    };
  }

  /**
   * Stop the fetcher: aborts the in-flight fetch (if any) and supersedes its outcome so
   * a late response is never applied.
   */
  stop(): void {
    this.latestRequestId += 1;
    this.activeController?.abort();
  }

  private applyOutcomeSideEffects(outcome: PrecomputedFetchOutcome): void {
    switch (outcome.kind) {
      case 'success':
        this.loggedWarmFailure = false;
        this.loggedAuthoritativeFailure = false;
        this.loggedOversize = false;
        break;
      case 'warm-failure':
        if (!this.loggedWarmFailure) {
          this.loggedWarmFailure = true;
          display.warn(
            'Failed to fetch feature flags assignments; the previous ones are kept if they match the current context.'
          );
        }
        break;
      case 'authoritative-failure':
        if (!this.loggedAuthoritativeFailure) {
          this.loggedAuthoritativeFailure = true;
          display.error(
            'Feature flags assignments are unavailable for this environment. Check that feature flags are enabled ' +
              'for this application and environment in Datadog, then wait for the next refresh.'
          );
        }
        break;
      case 'oversize':
        if (!this.loggedOversize) {
          this.loggedOversize = true;
          display.error(
            `The feature flags assignments exceed the maximum size and are dropped (limit: ${this.options.maxConfigurationLength} characters).`
          );
        }
        break;
      case 'superseded':
        break;
    }
  }
}

const WARM_FAILURE: PrecomputedFetchOutcome = { kind: 'warm-failure' };

/**
 * Classify a rejected fetch: HTTP 4xx is authoritative (D27); timeouts, network errors,
 * HTTP 5xx and undecodable bodies (the upstream `response.json()` throws) are warm.
 */
function classifyFetchError(_error: unknown, status: number | undefined): PrecomputedFetchOutcome {
  if (status !== undefined && status >= 400 && status < 500) {
    return { kind: 'authoritative-failure' };
  }
  return WARM_FAILURE;
}
