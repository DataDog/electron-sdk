import { SKIPPED } from '@datadog/js-core/assembly';
import type { TimeStamp } from '@datadog/js-core/time';
import type { FormatHooks } from '../../assembly';
import { EventSource } from '../../event';

/** Recorded evaluations for one flag inside one view, sorted by evaluation time. */
interface FlagRecord {
  variant: string;
  evaluatedAt: TimeStamp;
}

export interface FeatureFlagsRumContextDependencies {
  hooks: FormatHooks;
  /** Resolves the main view covering a time (new internal ViewContext API). */
  findViewId: (atTime: TimeStamp) => string | undefined;
  /** Requests a throttled view document update from the main view emitter. */
  requestViewUpdate: () => void;
  /** Whether RUM feature flag tracking is enabled. */
  enabled: () => boolean;
}

/**
 * Records main-process flag evaluations against the main view current at evaluation
 * time and attaches `feature_flags` to main RUM view and error events (D10).
 *
 * - View documents carry every flag recorded for the view id, whenever it was
 *   recorded relative to the view's own start: a view document reflects the view's
 *   state as of now.
 * - Error events carry, per flag, the last variant recorded at or before the error's
 *   start time, so errors stay time-accurate.
 * - Records are ordered by evaluation time, not arrival time (R3): a child or renderer
 *   record that arrives late only changes the past. A new flag or a change of the latest
 *   variant requests one throttled view update; a repeated identical evaluation does not.
 * - State is kept for the current and the previous view only, so the final inactive
 *   update after SESSION_EXPIRED still carries its flags while a renewed session starts
 *   with none.
 * - A view id with no recorded state (a crash replayed from a previous run) and
 *   renderer-sourced events return SKIPPED, so they never get current-run flags.
 */
export class FeatureFlagsRumContext {
  /** Insertion-ordered per-view flag records; at most current and previous view. */
  private readonly views = new Map<string, Map<string, FlagRecord[]>>();

  constructor(private readonly deps: FeatureFlagsRumContextDependencies) {
    deps.hooks.registerRum(({ eventType, startTime, source }) => {
      if (!deps.enabled() || source !== EventSource.MAIN) {
        return SKIPPED;
      }
      if (eventType !== 'view' && eventType !== 'error') {
        return SKIPPED;
      }
      const viewId = deps.findViewId(startTime);
      if (viewId === undefined) {
        // No covering view: e.g. a crash report replayed from a previous run.
        return SKIPPED;
      }
      const viewFlags = this.views.get(viewId);
      if (viewFlags === undefined || viewFlags.size === 0) {
        return SKIPPED;
      }
      if (eventType === 'view') {
        return { feature_flags: latestVariants(viewFlags) };
      }
      const flagsAtErrorTime = flagsRecordedAtOrBefore(viewFlags, startTime);
      if (Object.keys(flagsAtErrorTime).length === 0) {
        return SKIPPED;
      }
      return { feature_flags: flagsAtErrorTime };
    });
  }

  /** Record a main-process evaluation against the view covering its evaluation time. */
  record(flagKey: string, variant: string, evaluatedAt: TimeStamp): void {
    if (!this.deps.enabled()) {
      return;
    }
    const viewId = this.deps.findViewId(evaluatedAt);
    if (viewId === undefined) {
      return;
    }
    let viewFlags = this.views.get(viewId);
    if (viewFlags === undefined) {
      viewFlags = new Map();
      this.views.set(viewId, viewFlags);
      // Keep only the current and the previous view.
      while (this.views.size > 2) {
        const oldest = this.views.keys().next().value;
        if (oldest === undefined) {
          break;
        }
        this.views.delete(oldest);
      }
    }
    const records = viewFlags.get(flagKey);
    if (records === undefined) {
      viewFlags.set(flagKey, [{ variant, evaluatedAt }]);
      this.deps.requestViewUpdate();
      return;
    }
    if (insertByEvaluationTime(records, { variant, evaluatedAt })) {
      // Only a change of the latest variant changes the view document.
      this.deps.requestViewUpdate();
    }
  }

  /** Clear the recorded state. */
  stop(): void {
    this.views.clear();
  }
}

function latestVariants(viewFlags: Map<string, FlagRecord[]>): Record<string, string> {
  const flags: Record<string, string> = {};
  for (const [flagKey, records] of viewFlags) {
    flags[flagKey] = records[records.length - 1].variant;
  }
  return flags;
}

function flagsRecordedAtOrBefore(viewFlags: Map<string, FlagRecord[]>, startTime: TimeStamp): Record<string, string> {
  const flags: Record<string, string> = {};
  for (const [flagKey, records] of viewFlags) {
    for (let i = records.length - 1; i >= 0; i -= 1) {
      if (records[i].evaluatedAt <= startTime) {
        flags[flagKey] = records[i].variant;
        break;
      }
    }
  }
  return flags;
}

/**
 * Insert a record into a flag's timeline kept sorted by evaluation time (ties keep
 * arrival order). A record whose time predecessor has the same variant changes nothing
 * and is dropped; a time successor that repeats the inserted variant becomes redundant and
 * is removed, so the timeline only holds variant changes. Returns whether the latest
 * variant changed.
 */
function insertByEvaluationTime(records: FlagRecord[], record: FlagRecord): boolean {
  const latestVariant = records[records.length - 1].variant;
  let index = records.length;
  while (index > 0 && records[index - 1].evaluatedAt > record.evaluatedAt) {
    index -= 1;
  }
  if (index > 0 && records[index - 1].variant === record.variant) {
    return false;
  }
  records.splice(index, 0, record);
  if (index + 1 < records.length && records[index + 1].variant === record.variant) {
    records.splice(index + 1, 1);
  }
  return records[records.length - 1].variant !== latestVariant;
}
