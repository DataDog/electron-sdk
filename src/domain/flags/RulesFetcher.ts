import {
  configurationFromString,
  configurationToString,
  fetchRulesConfiguration,
} from '@datadog/openfeature-browser/rules-based';
import type { RulesConfigurationFetchOptions } from '@datadog/openfeature-browser/rules-based';
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

export const MAX_CONFIGURATION_LENGTH = 8 * 1024 * 1024;

export type RulesFetchOutcome =
  | { kind: 'success'; wire: string; fetchedAt: TimeStamp }
  | { kind: 'warm-failure' }
  | { kind: 'authoritative-failure' }
  | { kind: 'oversize' }
  | { kind: 'superseded' };

export interface RulesFetcherOptions {
  clientToken: string;
  site: string;
  env: string;
  flaggingProxy?: string;
  /** Milliseconds after which an in-flight fetch is aborted. */
  fetchTimeout: number;
  /** Maximum serialized configuration length; longer responses count as a failed fetch (D15). */
  maxConfigurationLength: number;
  fetch?: typeof globalThis.fetch;
}

/**
 * Fetches the rules-based flags configuration with the client token, classifies
 * failures and sequences concurrent requests so an older response never replaces a
 * newer one.
 *
 * Failure classes (D5/D6):
 * - *authoritative*: the source states rules are unavailable for this org (HTTP 4xx or a
 *   `rulesError` configuration).
 *   Surfaced once per failure streak through an actionable `display.error`; the owner
 *   drops the served configuration.
 * - *warm transient*: timeout, network error, HTTP 5xx or undecodable response (a 2xx
 *   body the decoder rejects, or a decoded configuration without evaluable rules). The
 *   owner keeps serving the held configuration.
 */
type Configuration = Awaited<ReturnType<typeof fetchRulesConfiguration>>;

const WARM_FAILURE: RulesFetchOutcome = { kind: 'warm-failure' };

/**
 * Classify a rejected fetch: HTTP 4xx is authoritative (D5); timeouts, network errors,
 * HTTP 5xx and undecodable 2xx bodies (the upstream decoder throws) are warm (D6).
 */
function classifyFetchError(_error: unknown, status: number | undefined): RulesFetchOutcome {
  if (status !== undefined && status >= 400 && status < 500) {
    return { kind: 'authoritative-failure' };
  }
  return WARM_FAILURE;
}

export class RulesFetcher {
  private latestRequestId = 0;
  private activeController?: AbortController;
  private loggedWarmFailure = false;
  private loggedAuthoritativeFailure = false;
  private loggedOversize = false;

  constructor(private readonly options: RulesFetcherOptions) {}

  fetch(): Promise<RulesFetchOutcome> {
    const requestId = ++this.latestRequestId;
    const controller = new AbortController();
    this.activeController = controller;
    const timeoutId = sdkSetTimeout(() => controller.abort(), this.options.fetchTimeout);
    // The upstream fetch throws a plain Error on HTTP failures: record the status of
    // the rules response here so failures can be classified (D5/D6).
    const responseStatus = { status: undefined as number | undefined };
    const recordingFetch: typeof globalThis.fetch = (input, init) => {
      const fetchImplementation = this.options.fetch ?? globalThis.fetch;
      return fetchImplementation(input, init).then((response: Response) => {
        // Not wrapped in monitor: a throw here would lose the response for the upstream code.
        responseStatus.status = response.status;
        return response;
      });
    };

    // The upstream runtime reads `flaggingProxy` from these options (see
    // buildConfigurationUrl) even though its RulesConfigurationFetchOptions type omits it.
    const fetchOptions: RulesConfigurationFetchOptions & { flaggingProxy?: string } = {
      clientToken: this.options.clientToken,
      site: this.options.site,
      env: this.options.env,
      fetch: recordingFetch,
      signal: controller.signal,
    };
    if (this.options.flaggingProxy !== undefined) {
      fetchOptions.flaggingProxy = this.options.flaggingProxy;
    }
    return fetchRulesConfiguration(fetchOptions)
      .then(
        (configuration) => callMonitored(() => this.classifyConfiguration(configuration)) ?? WARM_FAILURE,
        (error: unknown) => callMonitored(() => classifyFetchError(error, responseStatus.status)) ?? WARM_FAILURE
      )
      .then((outcome): RulesFetchOutcome => {
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
   * Classify a decoded configuration (B2): a `rulesError` is the source stating rules are
   * unavailable (authoritative); a configuration without evaluable rules, or one that does
   * not survive the wire round trip renderers use, is an undecodable response (warm). Only
   * an evaluable configuration is a success, so nothing else is ever cached or served READY.
   */
  private classifyConfiguration(configuration: Configuration): RulesFetchOutcome {
    if (configuration.rulesError !== undefined) {
      return { kind: 'authoritative-failure' };
    }
    if (configuration.rules === undefined) {
      return WARM_FAILURE;
    }
    let wire: string;
    try {
      wire = configurationToString(configuration);
    } catch (error) {
      // Serializing a decoded configuration is SDK code: report it, keep serving.
      addTelemetryError(error);
      return WARM_FAILURE;
    }
    if (wire.length > this.options.maxConfigurationLength) {
      return { kind: 'oversize' };
    }
    if (configurationFromString(wire).rules === undefined) {
      return WARM_FAILURE;
    }
    return { kind: 'success', wire, fetchedAt: timeStampNow() };
  }

  /**
   * Stop the fetcher: aborts the in-flight fetch (if any) and supersedes its outcome so
   * a late response is never applied.
   */
  stop(): void {
    this.latestRequestId += 1;
    this.activeController?.abort();
  }

  private applyOutcomeSideEffects(outcome: RulesFetchOutcome): void {
    switch (outcome.kind) {
      case 'success':
        this.loggedWarmFailure = false;
        this.loggedAuthoritativeFailure = false;
        this.loggedOversize = false;
        break;
      case 'warm-failure':
        if (!this.loggedWarmFailure) {
          this.loggedWarmFailure = true;
          display.warn('Failed to fetch feature flags configuration; the previous one is kept if available.');
        }
        break;
      case 'authoritative-failure':
        if (!this.loggedAuthoritativeFailure) {
          this.loggedAuthoritativeFailure = true;
          display.error(
            'Feature flags rules are unavailable for this environment. Enable "Allow local rule evaluation in client SDKs" ' +
              'and the "Client" distribution for this application in Datadog, then wait for the next refresh.'
          );
        }
        break;
      case 'oversize':
        if (!this.loggedOversize) {
          this.loggedOversize = true;
          display.error(
            `The feature flags configuration exceeds the maximum size and is dropped (limit: ${this.options.maxConfigurationLength} characters).`
          );
        }
        break;
      case 'superseded':
        break;
    }
  }
}
