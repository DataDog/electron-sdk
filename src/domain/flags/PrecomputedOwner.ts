import {
  addError as addTelemetryError,
  clearInterval as sdkClearInterval,
  setInterval as sdkSetInterval,
} from '../telemetry';
import { configurationFromString } from '@datadog/openfeature-browser/rules-based';
import type { FlagsState } from './FlagsState';
import type { PrecomputedFetcher, PrecomputedFetchOutcome } from './PrecomputedFetcher';
import type { PrecomputedCache } from './PrecomputedCache';
import type { AnonymousKeyStore } from './AnonymousKeyStore';
import type { FlatContext } from '../../common/flags/types';

export interface PrecomputedOwnerDependencies {
  /** Refresh cadence in milliseconds; 0 disables refresh. */
  refreshInterval: number;
  state: FlagsState;
  fetcher: PrecomputedFetcher;
  cache: PrecomputedCache;
  keyStore: AnonymousKeyStore;
  /**
   * The context to fetch assignments for at startup: the context a provider constructed
   * before `init()` holds, or the anonymous key. Defaults to the state's current context.
   */
  startupContext?: FlatContext;
}

/**
 * The `createdAt` of the precomputed assignments in a wire string, or `undefined`. It is
 * the configuration identity for exposure dedupe (M7/D29).
 */
export function precomputedCreatedAtOf(wire: string): string | undefined {
  try {
    return configurationFromString(wire).precomputed?.response.data.attributes.createdAt;
  } catch {
    return undefined;
  }
}

/**
 * Owns the precomputed-assignments lifecycle (M7): serves the per-context disk cache as
 * STALE while the first fetch is in flight, fetches assignments whenever the context
 * changes (D25), refreshes on a schedule (D26) and classifies failures (D27).
 *
 * A context change never mixes snapshots: while assignments for a changed *targeting
 * key* are fetched, defaults are published for the pending context (the snapshot holds
 * no configuration); for an attribute-only change the previous assignments keep being
 * served, as upstream does. The first successful fetch publishes configuration and
 * context atomically through {@link FlagsState.applyPrecomputedUpdate}.
 */
export class PrecomputedOwner {
  private refreshIntervalId: ReturnType<typeof setInterval> | undefined;
  private stopped = false;
  private fetchInFlight = false;
  private latestRequestId = 0;
  private inflightFetch: Promise<void> = Promise.resolve();
  private pending: FlatContext | undefined;

  /** The context whose assignments the in-flight fetch was started for, if one is in flight. */
  get pendingContext(): FlatContext | undefined {
    return this.pending;
  }

  private constructor(private readonly deps: PrecomputedOwnerDependencies) {}

  /** Start the owner; the first network fetch is never awaited (startup is never blocked). */
  static start(deps: PrecomputedOwnerDependencies): PrecomputedOwner {
    const owner = new PrecomputedOwner(deps);
    const startupContext = deps.startupContext ??
      deps.state.snapshot().context ?? { targetingKey: deps.keyStore.anonymousKey };
    const cached = deps.cache.entry(startupContext);
    if (cached !== undefined) {
      deps.state.applyPrecomputedUpdate({
        configuration: cached.wire,
        context: startupContext,
        status: 'STALE',
        configurationIdentity: precomputedCreatedAtOf(cached.wire),
      });
    }
    owner.fetchContext(startupContext);
    if (deps.refreshInterval > 0) {
      owner.refreshIntervalId = sdkSetInterval(() => {
        // A refresh must never supersede a context fetch in flight.
        if (!owner.fetchInFlight) {
          owner.fetchContext(owner.deps.state.snapshot().context ?? { targetingKey: owner.deps.keyStore.anonymousKey });
        }
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

  /**
   * Request assignments for a new evaluation context (already normalized). A request
   * matching the context whose assignments are already being fetched awaits that
   * in-flight fetch (duplicates coalesce); any other request supersedes it (the fetcher
   * aborts the older one, so the last request wins). Identical-to-served requests reach
   * the owner only when something else is in flight or they differ — the no-op for an
   * identical served context lives in the controller. Returns a promise that settles
   * once the outcome has been applied.
   */
  requestContext(context: FlatContext): Promise<void> {
    if (this.pending !== undefined && contextEquals(this.pending, context)) {
      // A matching fetch is already in flight: await it instead of issuing another (and
      // superseding) request for the same assignments.
      return this.inflightFetch;
    }
    const current = this.deps.state.snapshot().context;
    if (current === undefined || context.targetingKey !== current.targetingKey) {
      // Defaults while assignments for a changed targeting key are fetched (Q2). One
      // identity never sees another's assignments.
      this.deps.state.applyPrecomputedUpdate({ configuration: undefined, context, status: 'NOT_READY' });
    }
    // An attribute-only change keeps serving the previous snapshot until the new
    // assignments arrive (upstream behavior).
    this.fetchContext(context);
    return this.inflightFetch;
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

  private fetchContext(context: FlatContext): void {
    // Only the latest request's lifecycle controls the in-flight flag: a superseded
    // request settling must not let a refresh run while a newer request is still pending.
    const requestId = ++this.latestRequestId;
    this.pending = context;
    this.fetchInFlight = true;
    this.inflightFetch = this.runFetch(context)
      .catch((error: unknown) => {
        addTelemetryError(error);
      })
      .then(() => {
        if (requestId === this.latestRequestId) {
          this.fetchInFlight = false;
          this.pending = undefined;
        }
      });
  }

  private async runFetch(context: FlatContext): Promise<void> {
    const outcome = await this.deps.fetcher.fetch(context);
    if (this.stopped || outcome.kind === 'superseded') {
      return;
    }
    this.applyOutcome(outcome, context);
  }

  private applyOutcome(outcome: PrecomputedFetchOutcome, context: FlatContext): void {
    const state = this.deps.state;
    switch (outcome.kind) {
      case 'success': {
        state.applyPrecomputedUpdate({
          configuration: outcome.wire,
          context,
          status: 'READY',
          configurationIdentity: outcome.createdAt,
        });
        void this.deps.cache.write(context, outcome.wire, outcome.fetchedAt);
        break;
      }
      case 'warm-failure':
      case 'oversize': {
        const held = state.snapshot();
        if (held.configuration !== undefined && contextEquals(held.context, context)) {
          // The fetch was for the served context (a refresh): keep serving it as STALE.
          state.applyConfigurationUpdate({ configuration: held.configuration, status: 'STALE' });
          break;
        }
        const cached = this.deps.cache.entry(context);
        if (cached !== undefined) {
          state.applyPrecomputedUpdate({
            configuration: cached.wire,
            context,
            status: 'STALE',
            configurationIdentity: precomputedCreatedAtOf(cached.wire),
          });
        } else {
          // No assignments for this context: defaults with ERROR (Q3).
          state.applyPrecomputedUpdate({ configuration: undefined, context, status: 'ERROR' });
        }
        break;
      }
      case 'authoritative-failure':
        state.applyPrecomputedUpdate({ configuration: undefined, context, status: 'ERROR' });
        break;
      case 'superseded':
        break;
    }
  }
}

function contextEquals(a: FlatContext | undefined, b: FlatContext): boolean {
  return a !== undefined && JSON.stringify(a) === JSON.stringify(b);
}
