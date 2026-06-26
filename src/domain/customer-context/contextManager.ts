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
 * It owns the cloning, validation, and property-guard concerns shared by every context (user,
 * account, and later global context), so each context only needs to register its hook and declare
 * its config.
 */
export class ContextManager<T extends { extraInfo?: Context } = Context> {
  private standardFields: Context = {};
  private extraInfo: Context = {};

  constructor(
    private readonly name: string,
    private readonly propertiesConfig: PropertiesConfig = {},
    private readonly standardKeys?: Set<string>,
    private readonly protectedKeys?: Set<string>
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

  setContextProperty(key: string, value: unknown): void {
    if (this.rejectsProtectedKey(key)) return;

    if (this.isStandardKey(key)) {
      const candidate = { ...this.standardFields, [key]: deepClone(value) };
      if (!this.validateProperties(candidate)) return;
      this.standardFields = candidate;
    } else {
      // A custom attribute may only be added once the standard fields are valid (e.g. an `id` is
      // set); otherwise we'd emit a context that violates the schema (`{ usr: { plan } }` with no id).
      if (!this.validateProperties(this.standardFields)) return;
      this.extraInfo = { ...this.extraInfo, [key]: deepClone(value) };
    }
  }

  removeContextProperty(key: string): void {
    if (this.rejectsProtectedKey(key)) return;

    if (this.isStandardKey(key)) {
      const candidate = { ...this.standardFields };
      delete candidate[key];
      if (!this.validateProperties(candidate)) return;
      this.standardFields = candidate;
    } else {
      const next = { ...this.extraInfo };
      delete next[key];
      this.extraInfo = next;
    }
  }

  clearContext(): void {
    this.standardFields = {};
    this.extraInfo = {};
  }

  /**
   * Classifies a property key. A key is "standard" when the context declares no standard keys (a
   * plain context, where everything lives at the top level) or when the key is one of the declared
   * standard keys; any other key is a free-form `extraInfo` attribute.
   *
   * @param key - The property key to classify.
   * @returns `true` if the key is a standard field, `false` if it is an `extraInfo` attribute.
   */
  private isStandardKey(key: string): boolean {
    return !this.standardKeys || this.standardKeys.has(key);
  }

  /**
   * Protected keys (e.g. `id`) cannot be changed through the per-property API — they are only set
   * by replacing the whole context via {@link setContext}. Warns and returns `true` when `key` is
   * protected so the per-property callers can bail out instead of silently ignoring the request.
   *
   * @param key - The property key being set or removed.
   * @returns `true` if the key is protected (and a warning was emitted), `false` otherwise.
   */
  private rejectsProtectedKey(key: string): boolean {
    if (!this.protectedKeys?.has(key)) return false;
    displayWarn(`The property "${key}" of ${this.name} cannot be modified; the context will not be updated.`);
    return true;
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
