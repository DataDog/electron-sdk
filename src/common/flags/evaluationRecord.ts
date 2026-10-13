import type { TimeStamp } from '@datadog/js-core/time';
import type { EvaluationRecord } from './types';

/**
 * Remembers the `contextRevision` each resolution used, from the provider's `resolve*`
 * call to the `finally` hook of the same evaluation (B8, R1). OpenFeature runs `resolve*`,
 * the `after` hooks and the `finally` hooks synchronously, and an `after` hook may change
 * the context in between: reading the current revision in `finally` would attribute the
 * evaluation to the wrong context.
 *
 * Entries are keyed by the evaluation's own context object: the web SDK builds a fresh
 * context object per evaluation and passes that same object to `resolve*` and as
 * `hookContext.context` to every hook stage. So a nested evaluation of the same flag
 * (from a hook, even one whose `before` hook throws and never resolves) can never take
 * its parent's entry. A WeakMap keeps no evaluation alive after it completes.
 */
export class ResolutionLedger {
  private readonly revisions = new WeakMap<object, number>();

  record(invocationContext: unknown, contextRevision: number): void {
    if (isInvocationKey(invocationContext)) {
      this.revisions.set(invocationContext, contextRevision);
    }
  }

  /** The revision recorded for this evaluation's resolution, removed from the ledger. */
  take(invocationContext: unknown): number | undefined {
    if (!isInvocationKey(invocationContext)) {
      return undefined;
    }
    const revision = this.revisions.get(invocationContext);
    this.revisions.delete(invocationContext);
    return revision;
  }
}

function isInvocationKey(value: unknown): value is object {
  return typeof value === 'object' && value !== null;
}

interface EvaluationDetailsLike {
  variant?: string;
  reason?: string;
  errorCode?: string;
  flagMetadata: Record<string, unknown>;
}

/**
 * Build the record a provider's `finally` hook reports for one evaluation. Every
 * evaluation produces a record, defaults and errors included: the exposure collector
 * applies the upstream skip rules, and evaluation metrics count every evaluation. The
 * record carries no flag value and no context (D15).
 */
export function buildEvaluationRecord(
  flagKey: string,
  details: EvaluationDetailsLike,
  contextRevision: number,
  timestamp: TimeStamp
): EvaluationRecord {
  const metadata = details.flagMetadata;
  const record: EvaluationRecord = {
    flagKey,
    reason: details.reason ?? 'UNKNOWN',
    doLog: metadata.doLog === true,
    contextRevision,
    timestamp,
  };
  if (details.variant !== undefined && details.variant !== null) record.variant = details.variant;
  if (typeof metadata.allocationKey === 'string') record.allocationKey = metadata.allocationKey;
  if (details.errorCode !== undefined) record.errorCode = details.errorCode;
  if (typeof metadata.__dd_split_serial_id === 'number') record.serialId = metadata.__dd_split_serial_id;
  if (typeof metadata.__dd_core_configuration_id === 'string') {
    record.configurationId = metadata.__dd_core_configuration_id;
  } else if (typeof metadata.__dd_configuration_identity === 'string') {
    // Precomputed assignments: the `createdAt` captured at resolution time (D29), so the
    // record dedupes on the identity it was evaluated with, never a later refresh's.
    record.configurationId = metadata.__dd_configuration_identity;
  }
  return record;
}
