import { isIndexableObject } from '@datadog/js-core/util';

/** Backend-accepted character set for `vital.name`. */
export const VALID_VITAL_NAME_REGEX = /^[\w.@$-]*$/;

export function isValidString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

export function hasNonEmptyStringId(value: unknown): value is { id: string } {
  return isIndexableObject(value) && typeof value.id === 'string' && value.id.length > 0;
}
