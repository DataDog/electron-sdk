/** Backend-accepted character set for `vital.name`. */
export const VALID_VITAL_NAME_REGEX = /^[\w.@$-]*$/;

export function isValidString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}
