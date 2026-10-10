import {
  addError as addTelemetryError,
  clearInterval as sdkClearInterval,
  setInterval as sdkSetInterval,
} from '../telemetry';
import type { FlagsState } from './FlagsState';
import type { RulesFetcher, RulesFetchOutcome } from './RulesFetcher';
import type { ConfigurationCache } from './ConfigurationCache';
import type { AnonymousKeyStore } from './AnonymousKeyStore';

export interface FlagsOwnerDependencies {
  /** Refresh cadence in milliseconds; 0 disables refresh. */
  refreshInterval: number;
  state: FlagsState;
  fetcher: RulesFetcher;
  cache: ConfigurationCache;
  keyStore: AnonymousKeyStore;
}

/**
 * Owns the flags lifecycle: serves the disk cache as STALE while the first network
 * fetch is in flight, applies fetch outcomes to the state, refreshes on a schedule and
 * persists valid configurations (D6/D7).
 */
export class FlagsOwner {
  private refreshIntervalId: ReturnType<typeof setInterval> | undefined;
  private fetchSequence = 0;
  private stopped = false;
  private inflightFetch: Promise<void> = Promise.resolve();

  private constructor(private readonly deps: FlagsOwnerDependencies) {}

  /**
   * Start the owner: serve the cache as STALE synchronously, start the first network
   * fetch without waiting for it (startup is never blocked on the network, B12), then
   * schedule refreshes. Use {@link settled} to wait for the in-flight fetch.
   */
  static start(deps: FlagsOwnerDependencies): FlagsOwner {
    const owner = new FlagsOwner(deps);
    const cached = deps.cache.entry();
    if (cached !== undefined) {
      deps.state.applyConfigurationUpdate({ configuration: cached.wire, status: 'STALE' });
    }
    owner.scheduleFetch();
    if (deps.refreshInterval > 0) {
      owner.refreshIntervalId = sdkSetInterval(() => {
        owner.scheduleFetch();
      }, deps.refreshInterval);
    }
    return owner;
  }

  /** Resolves once the latest started fetch has been applied (or ignored). */
  settled(): Promise<void> {
    return this.inflightFetch;
  }

  /** The anonymous key store, exposed for context normalization by the main provider. */
  get keyStore(): AnonymousKeyStore {
    return this.deps.keyStore;
  }

  /** Apply a new evaluation context (already normalized). */
  updateContext(context: Parameters<FlagsState['applyContextUpdate']>[0]): void {
    this.deps.state.applyContextUpdate(context);
  }

  /**
   * Stop the owner: clears the refresh interval, aborts the in-flight fetch, ignores
   * late outcomes and waits for the pending cache write.
   */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.refreshIntervalId !== undefined) {
      sdkClearInterval(this.refreshIntervalId);
      this.refreshIntervalId = undefined;
    }
    this.deps.fetcher.stop();
    await this.deps.cache.idle();
  }

  /** Start a fetch and keep its promise; a rejection is reported to telemetry, never unhandled. */
  private scheduleFetch(): void {
    this.inflightFetch = this.runFetch().catch((error: unknown) => {
      addTelemetryError(error);
    });
  }

  private async runFetch(): Promise<void> {
    const sequence = ++this.fetchSequence;
    const outcome = await this.deps.fetcher.fetch();
    if (this.stopped || sequence !== this.fetchSequence) {
      return;
    }
    this.applyOutcome(outcome);
  }

  private applyOutcome(outcome: RulesFetchOutcome): void {
    const state = this.deps.state;
    switch (outcome.kind) {
      case 'success':
        state.applyConfigurationUpdate({ configuration: outcome.wire, status: 'READY' });
        void this.deps.cache.write(outcome.wire, outcome.fetchedAt);
        break;
      case 'warm-failure':
      case 'oversize':
        state.applyConfigurationUpdate({
          configuration: state.snapshot().configuration,
          status: state.snapshot().configuration !== undefined ? 'STALE' : 'ERROR',
        });
        break;
      case 'authoritative-failure':
        state.applyConfigurationUpdate({ configuration: undefined, status: 'ERROR' });
        break;
      case 'superseded':
        break;
    }
  }
}
