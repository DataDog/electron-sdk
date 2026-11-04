import type { Context } from '@datadog/js-core/util';

/**
 * Failure reason for a RUM Operation step.
 *
 * Matches the schema enum values in vital-operation-step-schema.json.
 */
export type FailureReason = 'error' | 'abandoned' | 'other';

/**
 * Options accepted by the RUM Operation APIs.
 *
 * Mirrors the browser-sdk's `FeatureOperationOptions` shape so consumers can share one mental model across main
 * process and renderer process.
 */
export interface FeatureOperationOptions {
  /**
   * Key distinguishing parallel operations with the same name (e.g. separate upload tasks sharing the name "upload").
   * When omitted, the operation is treated as unkeyed.
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
