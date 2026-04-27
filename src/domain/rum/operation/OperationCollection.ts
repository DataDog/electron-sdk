import { type Context, generateUUID, isIndexableObject, timeStampNow } from '@datadog/browser-core';
import { EventFormat, EventKind, EventManager, EventSource } from '../../../event';
import { displayError, displayWarn } from '../../../tools/display';
import type { RawRumVital } from '../rawRumData.types';

type OperationMethod = 'startOperation' | 'succeedOperation' | 'failOperation';

// Map of deprecated -> canonical method names. The deprecated wrappers fire a
// runtime warning once per method name and forward to the canonical
// implementation. Kept in OperationCollection (rather than in src/index.ts)
// so the wiring is in one testable place; the customer-facing `@deprecated`
// JSDoc lives on the public exports in src/index.ts where IDEs surface it.
const DEPRECATED_TO_CANONICAL: Record<string, OperationMethod> = {
  startFeatureOperation: 'startOperation',
  succeedFeatureOperation: 'succeedOperation',
  failFeatureOperation: 'failOperation',
};

/**
 * Failure reason for a RUM Operation step.
 *
 * Matches the schema enum values in vital-operation-step-schema.json.
 */
export type FailureReason = 'error' | 'abandoned' | 'other';

/**
 * Options accepted by the RUM Operation APIs.
 *
 * Mirrors the browser-sdk's `FeatureOperationOptions` shape so consumers can
 * share one mental model across main process and renderer process.
 */
export interface FeatureOperationOptions {
  /**
   * Key distinguishing parallel operations with the same name (e.g. separate
   * upload tasks sharing the name "upload"). When omitted, the operation is
   * treated as unkeyed.
   */
  operationKey?: string;

  /**
   * Custom attributes merged into the event's `context` section.
   */
  context?: Context;

  /**
   * Free-form description attached to `vital.description`.
   */
  description?: string;
}

/**
 * Collect RUM vital operation step events emitted from the main process.
 *
 * No local duplicate-start / stop-without-start tracking is performed:
 * renderer-originated start/stop events (from the bundled browser-sdk)
 * flow through the bridge without updating main-process state, so any
 * cross-process tracking would produce false positives when a developer
 * legitimately starts in one process and stops in the other. Matches the
 * bundled browser-sdk's no-tracking behavior; aligns with Android and
 * Browser in the spec's parity matrix.
 */
export class OperationCollection {
  // Tracks which deprecated method names have already emitted their one-time
  // deprecation warning, so noisy hot-path callers don't drown the console.
  private readonly warnedDeprecations = new Set<string>();

  constructor(private readonly eventManager: EventManager) {}

  getApi() {
    return {
      startOperation: (name: string, options?: FeatureOperationOptions) => this.handle('startOperation', name, options),
      succeedOperation: (name: string, options?: FeatureOperationOptions) =>
        this.handle('succeedOperation', name, options),
      failOperation: (name: string, failureReason: FailureReason, options?: FeatureOperationOptions) =>
        this.handle('failOperation', name, options, failureReason),

      // Deprecated wrappers — kept for backwards compatibility until the next
      // major. They warn-once-per-method and forward to the canonical methods
      // above. Do not call these from new code; use the un-prefixed names.
      startFeatureOperation: (name: string, options?: FeatureOperationOptions) =>
        this.handleDeprecated('startFeatureOperation', name, options),
      succeedFeatureOperation: (name: string, options?: FeatureOperationOptions) =>
        this.handleDeprecated('succeedFeatureOperation', name, options),
      failFeatureOperation: (name: string, failureReason: FailureReason, options?: FeatureOperationOptions) =>
        this.handleDeprecated('failFeatureOperation', name, options, failureReason),
    };
  }

  stop(): void {
    // No owned resources to release; method kept for RumCollection symmetry.
  }

  private handle(
    method: OperationMethod,
    name: string,
    options: FeatureOperationOptions | undefined,
    failureReason?: FailureReason
  ): void {
    if (!validateArgs(method, name, options)) {
      return;
    }
    const stepType = method === 'startOperation' ? 'start' : 'end';
    this.emitOperationStep(stepType, name, options, failureReason);
  }

  private handleDeprecated(
    deprecatedMethod: keyof typeof DEPRECATED_TO_CANONICAL,
    name: string,
    options: FeatureOperationOptions | undefined,
    failureReason?: FailureReason
  ): void {
    const canonical = DEPRECATED_TO_CANONICAL[deprecatedMethod];
    if (!this.warnedDeprecations.has(deprecatedMethod)) {
      this.warnedDeprecations.add(deprecatedMethod);
      displayWarn(
        `${deprecatedMethod}() is deprecated and will be removed in a future major release. Use ${canonical}() instead.`
      );
    }
    this.handle(canonical, name, options, failureReason);
  }

  private emitOperationStep(
    stepType: 'start' | 'end',
    name: string,
    options: FeatureOperationOptions | undefined,
    failureReason?: FailureReason
  ): void {
    const startTime = timeStampNow();
    const vital: RawRumVital['vital'] = {
      id: generateUUID(),
      name,
      type: 'operation_step',
      step_type: stepType,
    };
    if (options?.operationKey !== undefined) {
      vital.operation_key = options.operationKey;
    }
    if (failureReason !== undefined) {
      vital.failure_reason = failureReason;
    }
    if (options?.description !== undefined) {
      vital.description = options.description;
    }

    const data: RawRumVital = {
      type: 'vital',
      date: startTime,
      context: options?.context ?? {},
      vital,
    };

    this.eventManager.notify({
      kind: EventKind.RAW,
      source: EventSource.MAIN,
      format: EventFormat.RUM,
      data,
      startTime,
    });
  }
}

function isValidString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

// Mirrors the backend's server-side `vital.name` character-set regex,
// `[\w.@$-]*` (letters, digits, `_`, `.`, `@`, `$`, `-`). Names that fail
// this pattern generate a developer warning but the event is still emitted
// — the backend is the source of truth on character-set policy, so client-
// side drop would force a customer SDK bump if the rule is ever relaxed.
// Blank / empty names are a separate check: they are rejected here because
// the backend rejects them with its own non-empty precondition before
// reaching the regex.
const VALID_OPERATION_NAME_REGEX = /^[\w.@$-]*$/;

function validateArgs(method: OperationMethod, name: unknown, options: unknown): boolean {
  if (!isValidString(name)) {
    displayError(`${method}: operation name cannot be empty or blank. Event will not be sent.`);
    return false;
  }
  if (!VALID_OPERATION_NAME_REGEX.test(name)) {
    // Warn but do not drop — the backend decides on character-set policy.
    displayWarn(
      `${method}: operation name '${name}' does not match the backend-accepted pattern [\\w.@$-]* (letters, digits, _ . @ $ -). The event will still be sent and may be rejected by the backend.`
    );
  }
  if (options !== undefined && !isIndexableObject(options)) {
    displayError(`${method}: options must be an object when provided. Event will not be sent.`);
    return false;
  }
  if (isIndexableObject(options) && options.operationKey !== undefined && !isValidString(options.operationKey)) {
    displayError(`${method}: operation key cannot be empty or blank. Event will not be sent.`);
    return false;
  }
  return true;
}
