import { isIndexableObject } from '@datadog/js-core/util';
import type { TimeStamp } from '@datadog/js-core/time';
import type {
  EvaluationBatch,
  EvaluationRecord,
  FlagsSnapshot,
  FlagsStatus,
  FlagsTracking,
  FlatContext,
} from './types';

/** Evaluation batch limits, shared by every producer (reporter) and the main intake (A2). */
export const MAX_BATCH_RECORDS = 100;
export const MAX_BATCH_ERROR_MESSAGE_LENGTH = 1024;
/** At most this many SDK errors ride along with one batch. */
export const MAX_BATCH_ERRORS = 5;
/** Bound of one serialized evaluation batch, in UTF-8 bytes of the whole envelope (R4). */
export const MAX_BATCH_BYTES = 64 * 1024;
export const MAX_FLAG_KEY_LENGTH = 256;
export const MAX_VARIANT_LENGTH = 256;
export const MAX_ALLOCATION_KEY_LENGTH = 256;
export const MAX_VIEW_URL_LENGTH = 2048;

const FLAGS_STATUSES: FlagsStatus[] = ['DISABLED', 'NOT_READY', 'READY', 'STALE', 'ERROR'];
const MINIMAL_STATUSES: FlagsStatus[] = ['DISABLED', 'NOT_READY'];

function isFlagsStatus(value: unknown): value is FlagsStatus {
  return typeof value === 'string' && (FLAGS_STATUSES as string[]).includes(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isFlatContext(value: unknown): value is FlatContext {
  if (!isIndexableObject(value) || typeof value.targetingKey !== 'string' || value.targetingKey.length === 0) {
    return false;
  }
  return Object.entries(value).every(
    ([key, attribute]) =>
      key === 'targetingKey' ||
      typeof attribute === 'string' ||
      typeof attribute === 'number' ||
      typeof attribute === 'boolean'
  );
}

/**
 * Parse and validate a snapshot received over IPC. All-or-nothing: any invalid field
 * rejects the whole snapshot (renderers keep serving their previous snapshot instead).
 * Accepts the minimal pre-init/disabled shape, the full READY/STALE/ERROR shape and the
 * pending-identity `NOT_READY` invalidation (revision >= 1, the new context, no
 * configuration); a minimal-status snapshot must not carry a configuration or an error
 * message, a context only as that invalidation, and never at revision 0 (the pre-init
 * privacy contract).
 */
export function parseFlagsSnapshot(json: string): FlagsSnapshot | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return undefined;
  }
  if (!isIndexableObject(parsed)) {
    return undefined;
  }
  if (!isFiniteNumber(parsed.revision) || !isFlagsStatus(parsed.status)) {
    return undefined;
  }
  if (!isFiniteNumber(parsed.contextRevision) || !isFiniteNumber(parsed.configurationRevision)) {
    return undefined;
  }
  if (
    !isIndexableObject(parsed.tracking) ||
    typeof parsed.tracking.exposures !== 'boolean' ||
    typeof parsed.tracking.rum !== 'boolean' ||
    typeof parsed.tracking.evaluations !== 'boolean'
  ) {
    return undefined;
  }
  if (parsed.errorMessage !== undefined && typeof parsed.errorMessage !== 'string') {
    return undefined;
  }
  const tracking: FlagsTracking = {
    exposures: parsed.tracking.exposures,
    rum: parsed.tracking.rum,
    evaluations: parsed.tracking.evaluations,
  };
  const isMinimal = (MINIMAL_STATUSES as string[]).includes(parsed.status);
  if (isMinimal) {
    const invalidation = parsed.status === 'NOT_READY' && parsed.revision >= 1 && parsed.context !== undefined;
    if (
      parsed.configuration !== undefined ||
      parsed.errorMessage !== undefined ||
      (parsed.context !== undefined && !invalidation) ||
      (invalidation && !isFlatContext(parsed.context))
    ) {
      return undefined;
    }
    return {
      revision: parsed.revision,
      status: parsed.status,
      ...(invalidation ? { context: parsed.context as FlatContext } : {}),
      contextRevision: parsed.contextRevision,
      configurationRevision: parsed.configurationRevision,
      tracking,
    };
  }
  if (parsed.configuration !== undefined && typeof parsed.configuration !== 'string') {
    return undefined;
  }
  if (parsed.context !== undefined && !isFlatContext(parsed.context)) {
    return undefined;
  }
  const snapshot: FlagsSnapshot = {
    revision: parsed.revision,
    status: parsed.status,
    contextRevision: parsed.contextRevision,
    configurationRevision: parsed.configurationRevision,
    tracking,
    ...(parsed.configuration !== undefined ? { configuration: parsed.configuration } : {}),
    ...(parsed.context !== undefined ? { context: parsed.context } : {}),
    ...(parsed.errorMessage !== undefined ? { errorMessage: parsed.errorMessage } : {}),
  };
  return snapshot;
}

function parseRecord(input: unknown): EvaluationRecord | undefined {
  if (!isIndexableObject(input)) {
    return undefined;
  }
  const {
    flagKey,
    variant,
    allocationKey,
    reason,
    errorCode,
    doLog,
    serialId,
    configurationId,
    contextRevision,
    timestamp,
    viewId,
    viewUrl,
  } = input;
  if (typeof flagKey !== 'string' || flagKey.length === 0 || flagKey.length > MAX_FLAG_KEY_LENGTH) {
    return undefined;
  }
  if (variant !== undefined && (typeof variant !== 'string' || variant.length > MAX_VARIANT_LENGTH)) {
    return undefined;
  }
  if (
    allocationKey !== undefined &&
    (typeof allocationKey !== 'string' || allocationKey.length > MAX_ALLOCATION_KEY_LENGTH)
  ) {
    return undefined;
  }
  if (typeof reason !== 'string') {
    return undefined;
  }
  if (errorCode !== undefined && typeof errorCode !== 'string') {
    return undefined;
  }
  if (typeof doLog !== 'boolean') {
    return undefined;
  }
  if (serialId !== undefined && !isFiniteNumber(serialId)) {
    return undefined;
  }
  if (configurationId !== undefined && typeof configurationId !== 'string') {
    return undefined;
  }
  if (!isFiniteNumber(contextRevision) || !isFiniteNumber(timestamp)) {
    return undefined;
  }
  if (viewId !== undefined && typeof viewId !== 'string') {
    return undefined;
  }
  const record: EvaluationRecord = { flagKey, reason, doLog, contextRevision, timestamp: timestamp as TimeStamp };
  if (variant !== undefined) {
    record.variant = variant;
  }
  if (allocationKey !== undefined) {
    record.allocationKey = allocationKey;
  }
  if (errorCode !== undefined) {
    record.errorCode = errorCode;
  }
  if (serialId !== undefined) {
    record.serialId = serialId;
  }
  if (configurationId !== undefined) {
    record.configurationId = configurationId;
  }
  if (viewId !== undefined) {
    record.viewId = viewId;
  }
  if (viewUrl !== undefined) {
    if (typeof viewUrl !== 'string') {
      return undefined;
    }
    record.viewUrl = viewUrl.length > MAX_VIEW_URL_LENGTH ? viewUrl.slice(0, MAX_VIEW_URL_LENGTH) : viewUrl;
  }
  return record;
}

/**
 * Parse a renderer evaluation batch with partial acceptance: the payload itself is
 * validated whole (string, at most `maxBytes` UTF-8 bytes, JSON, with a records array), then each
 * record is validated individually — invalid records are dropped and counted in
 * `droppedCount`, together with records beyond the per-batch cap. Invalid fields that
 * are truncatable (viewUrl, error messages and stacks) are truncated instead of
 * dropping the record. A sender-reported `droppedCount` (records it dropped before
 * sending, e.g. one that alone exceeds the batch bound) is added to the count.
 */
export function parseEvaluationBatch(
  json: string,
  maxBytes: number
): { batch: EvaluationBatch; droppedCount: number } | undefined {
  // A UTF-16 unit is at least one UTF-8 byte: the cheap length check rejects most oversize
  // payloads before the byte count, and both run before parsing.
  if (typeof json !== 'string' || json.length > maxBytes || utf8ByteLength(json) > maxBytes) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return undefined;
  }
  if (!isIndexableObject(parsed) || !Array.isArray(parsed.records)) {
    return undefined;
  }
  let invalidRecordCount = 0;
  const records: EvaluationRecord[] = [];
  for (const input of parsed.records.slice(0, MAX_BATCH_RECORDS)) {
    const record = parseRecord(input);
    if (record === undefined) {
      invalidRecordCount += 1;
    } else {
      records.push(record);
    }
  }
  const errors: { message: string; stack?: string }[] = [];
  if (Array.isArray(parsed.errors)) {
    for (const input of parsed.errors.slice(0, MAX_BATCH_ERRORS)) {
      if (!isIndexableObject(input) || typeof input.message !== 'string') {
        continue;
      }
      const error: { message: string; stack?: string } = {
        message: input.message.slice(0, MAX_BATCH_ERROR_MESSAGE_LENGTH),
      };
      if (typeof input.stack === 'string') {
        error.stack = input.stack.slice(0, MAX_BATCH_ERROR_MESSAGE_LENGTH);
      }
      errors.push(error);
    }
  }
  const batch: EvaluationBatch = { records };
  if (errors.length > 0) {
    batch.errors = errors;
  }
  const senderDroppedCount =
    typeof parsed.droppedCount === 'number' && Number.isSafeInteger(parsed.droppedCount) && parsed.droppedCount > 0
      ? Math.min(parsed.droppedCount, MAX_SENDER_DROPPED_COUNT)
      : 0;
  return {
    batch,
    droppedCount: Math.max(0, parsed.records.length - MAX_BATCH_RECORDS) + invalidRecordCount + senderDroppedCount,
  };
}

export type { EvaluationBatch };

const MAX_SENDER_DROPPED_COUNT = 1_000_000;

/**
 * The UTF-8 encoded size of a string, as `TextEncoder` / `Buffer.byteLength` would report
 * it (R4), without either (shared code is runtime-agnostic): 1–3 bytes per UTF-16 unit, 4
 * per surrogate pair, 3 for a lone surrogate (encoded as U+FFFD).
 */
export function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
}
