import type { TimeStamp } from '@datadog/js-core/time';

/**
 * Lifecycle state of the feature flags subsystem.
 *
 * - `DISABLED`: the `featureFlags` option was not set at init.
 * - `NOT_READY`: enabled but no configuration has been fetched yet.
 * - `READY`: a configuration was fetched from the network (or recovered).
 * - `STALE`: a cached or previously-fetched configuration is served while the network fails.
 * - `ERROR`: no configuration is available and the last fetch failed.
 */
export type FlagsStatus = 'DISABLED' | 'NOT_READY' | 'READY' | 'STALE' | 'ERROR';

/**
 * Flat, primitive-only flag evaluation context. Nested values are not supported: the
 * upstream evaluator only reads flat attributes.
 */
export type FlatContext = { targetingKey: string } & Record<string, string | number | boolean>;

/** Tracking toggles published in every snapshot. Immutable once published (frozen by `FlagsState`). */
export interface FlagsTracking {
  readonly exposures: boolean;
  readonly rum: boolean;
  readonly evaluations: boolean;
}

/**
 * Full snapshot of the flags state, sent from main to renderers. The minimal variant
 * (sent before init or when flags are disabled) carries all scalar fields and
 * `tracking` but no `configuration`, `context` or `errorMessage`. Immutable once published:
 * `FlagsState` freezes every snapshot together with its context and tracking.
 */
export interface FlagsSnapshot {
  readonly revision: number;
  readonly status: FlagsStatus;
  readonly configuration?: string;
  readonly context?: Readonly<FlatContext>;
  readonly contextRevision: number;
  readonly configurationRevision: number;
  readonly tracking: FlagsTracking;
  readonly errorMessage?: string;
}

/**
 * A single flag evaluation, as reported by a provider hook. Carries no flag value and
 * no evaluation context: main re-resolves the context from the originating
 * `contextRevision` (D8/D15).
 */
export interface EvaluationRecord {
  flagKey: string;
  variant?: string;
  allocationKey?: string;
  reason: string;
  errorCode?: string;
  doLog: boolean;
  serialId?: number;
  configurationId?: string;
  contextRevision: number;
  timestamp: TimeStamp;
  viewId?: string;
  viewUrl?: string;
}

export interface EvaluationBatch {
  records: EvaluationRecord[];
  errors?: { message: string; stack?: string }[];
  /** Records the sender dropped before sending (e.g. one larger than the batch bound on its own). */
  droppedCount?: number;
}
