import { combine, deepClone } from '@datadog/js-core/util';
import { isEmptyObject } from '@datadog/browser-core';
import { displayWarn } from '../../tools/display';

export type Context = Record<string, unknown>;

/**
 * Declares which context properties are required and/or constrained to a given format.
 * Mirrors browser-core's contextManager configuration so the same validation rules apply.
 * @see https://github.com/DataDog/browser-sdk/blob/main/packages/browser-core/src/domain/context/contextManager.ts
 */
export type PropertiesConfig = Record<
  string,
  {
    required?: boolean;
    type?: 'string';
  }
>;

/**
 * Generic store for a context that injects it into events.
 *
 * It keeps the standard fields (validated, e.g. `id`/`name`) and the free-form `extraInfo`
 * attributes in two separate stores, so it never has to flatten/unflatten between the public
 * "info" shape and the flat shape sent on events. When a key appears in both stores, the standard
 * field wins (see {@link getContext}).
 *
 * It owns the cloning and validation concerns shared by every context (user, account, and later
 * global context), so each context only needs to register its hook and declare its config.
 */
export class ContextManager<T extends { extraInfo?: Context } = Context> {
  private standardFields: Context = {};
  private extraInfo: Context = {};

  constructor(
    private readonly name: string,
    private readonly propertiesConfig: PropertiesConfig = {}
  ) {}

  /**
   * Returns the flat context (standard fields plus extra attributes). Used by format hooks to
   * inject into events. Standard fields take precedence when a key appears in both stores.
   */
  getContext(): Context {
    return combine(this.extraInfo, this.standardFields);
  }

  /**
   * Returns the typed info object (with `extraInfo` nested), or `undefined` if empty.
   */
  getInfo(): T | undefined {
    if (this.isEmpty()) return undefined;
    const info = deepClone(this.standardFields);
    if (!isEmptyObject(this.extraInfo)) {
      info.extraInfo = deepClone(this.extraInfo);
    }
    return info as T;
  }

  isEmpty(): boolean {
    return isEmptyObject(this.standardFields) && isEmptyObject(this.extraInfo);
  }

  setContext(info: T): void {
    const { extraInfo, ...standardFields } = deepClone(info) as Context & { extraInfo?: Context };
    const candidate = pickDefined(standardFields);
    if (!this.validateProperties(candidate)) return;

    this.standardFields = candidate;
    this.extraInfo = extraInfo ?? {};
  }

  /**
   * Merges custom attributes into `extraInfo`, leaving the standard fields untouched. Only applies
   * when the current standard fields are valid: a context with a required field (account needs an
   * `id`) is a no-op until that field is set, while a context with no required field (user) accepts
   * attributes freely — even before any identity is set, so the backend can derive the id from
   * `anonymous_id`. Standard keys are never overwritten by `extraInfo` (see {@link getContext}), so
   * this cannot change `id`/`name`/`email`.
   */
  addExtraInfo(extraInfo: Context): void {
    if (!this.validateProperties(this.standardFields)) return;
    this.extraInfo = { ...this.extraInfo, ...deepClone(extraInfo) };
  }

  clearContext(): void {
    this.standardFields = {};
    this.extraInfo = {};
  }

  /**
   * Validates that required properties are present and that constrained properties have the right
   * format. Returns `false` (and warns) when the candidate is invalid, in which case the caller
   * keeps the previous context rather than corrupting it.
   */
  private validateProperties(standardFields: Context): boolean {
    for (const [key, { required, type }] of Object.entries(this.propertiesConfig)) {
      const value = standardFields[key];

      if (required && !isValuePresent(value)) {
        displayWarn(`The property "${key}" of ${this.name} is required; the context will not be updated.`);
        return false;
      }

      if (type === 'string' && isValuePresent(value) && typeof value !== 'string') {
        displayWarn(`The property "${key}" of ${this.name} must be a string; the context will not be updated.`);
        return false;
      }
    }
    return true;
  }
}

function isValuePresent(value: unknown): boolean {
  return value !== undefined && value !== null && value !== '';
}

/**
 * Filters out entries whose value is `undefined`, so unset standard fields are not stored as
 * explicit `undefined` keys.
 *
 * @param context - The object to filter.
 * @returns A shallow copy of `context` keeping only entries whose value is defined.
 */
function pickDefined(context: Context): Context {
  const result: Context = {};
  for (const [key, value] of Object.entries(context)) {
    if (value !== undefined) result[key] = value;
  }
  return result;
}
