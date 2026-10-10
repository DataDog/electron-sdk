import { Observable, type Subscription } from '@datadog/browser-core';
import { monitor } from '../telemetry';
import type { FlagsSnapshot, FlagsStatus, FlagsTracking, FlatContext } from '../../common/flags/types';

const RETAINED_CONTEXTS = 10;

interface RetainedContext {
  contextRevision: number;
  context: FlatContext;
}

/**
 * The single source of truth for the flags state: status, serialized configuration,
 * evaluation context and their revisions. Every mutation publishes a new immutable
 * snapshot to subscribers synchronously (through `monitor`). Incoming context and tracking
 * objects are copied (the caller keeps ownership and nothing it owns is frozen); every
 * published snapshot, its context and tracking, and every retained context are frozen. The last
 * {@link RETAINED_CONTEXTS} contexts are retained by revision so exposure records can
 * be resolved to the context they actually used (D8).
 */
export class FlagsState {
  private readonly changes = new Observable<FlagsSnapshot>();
  private retainedContexts: RetainedContext[] = [];
  private current: FlagsSnapshot;

  constructor(
    initialContext: FlatContext,
    tracking: FlagsTracking = { exposures: true, rum: true, evaluations: true }
  ) {
    const context = frozenCopy(initialContext);
    this.current = Object.freeze({
      revision: 0,
      status: 'NOT_READY',
      context,
      contextRevision: 0,
      configurationRevision: 0,
      tracking: frozenTracking(tracking),
    });
    this.retainedContexts.push({ contextRevision: 0, context });
  }

  /** Apply a configuration update: bumps `configurationRevision` when a configuration is served. */
  applyConfigurationUpdate(update: { configuration?: string; status: FlagsStatus; errorMessage?: string }): void {
    const configurationChanged =
      update.configuration !== undefined && update.configuration !== this.current.configuration;
    this.current = Object.freeze({
      ...this.current,
      revision: this.current.revision + 1,
      configuration: update.configuration,
      status: update.status,
      errorMessage: update.errorMessage,
      configurationRevision: configurationChanged
        ? this.current.configurationRevision + 1
        : this.current.configurationRevision,
    });
    this.notify();
  }

  /** Replace the evaluation context (never merged) and retain it by its new revision. */
  applyContextUpdate(update: FlatContext): void {
    const context = frozenCopy(update);
    const contextRevision = this.current.contextRevision + 1;
    this.retainedContexts.push({ contextRevision, context });
    while (this.retainedContexts.length > RETAINED_CONTEXTS) {
      this.retainedContexts.shift();
    }
    this.current = Object.freeze({
      ...this.current,
      revision: this.current.revision + 1,
      context,
      contextRevision,
    });
    this.notify();
  }

  /** Update the tracking toggles published in every snapshot. */
  setTracking(tracking: FlagsTracking): void {
    this.current = Object.freeze({
      ...this.current,
      revision: this.current.revision + 1,
      tracking: frozenTracking(tracking),
    });
    this.notify();
  }

  /** The current snapshot (frozen, with a frozen context and tracking). */
  snapshot(): FlagsSnapshot {
    return this.current;
  }

  /** The (frozen) context for a given context revision, or `undefined` when it has been evicted. */
  getContext(contextRevision: number): FlatContext | undefined {
    return this.retainedContexts.find((retained) => retained.contextRevision === contextRevision)?.context;
  }

  /** Subscribe to snapshot changes. Notifications are synchronous and monitored. */
  subscribe(callback: (snapshot: FlagsSnapshot) => void): Subscription {
    return this.changes.subscribe(monitor(callback));
  }

  private notify(): void {
    this.changes.notify(this.current);
  }
}

/** A frozen copy of a flat context (its values are primitives, so one level is the whole object). */
function frozenCopy(context: FlatContext): FlatContext {
  return Object.freeze({ ...context });
}

function frozenTracking(tracking: FlagsTracking): FlagsTracking {
  return Object.freeze({ exposures: tracking.exposures, rum: tracking.rum, evaluations: tracking.evaluations });
}
