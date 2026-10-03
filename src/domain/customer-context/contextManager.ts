import { combine, deepClone } from '@datadog/js-core/util';
import { isEmptyObject } from '@datadog/browser-core';
import { display } from '../../tools/display';

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
 * Validates and stores the customer's current context, independently of event history.
 *
 * It keeps the standard fields (validated, e.g. `id`/`name`) and the free-form `extraInfo`
 * attributes in two separate stores, so it never has to flatten/unflatten between the public
 * "info" shape and the flat shape sent on events. Keys declared as standard fields are excluded
 * from `extraInfo`, so they can only be set through the validated top-level properties.
 *
 * Mutations notify the owning context after validation and cloning; rejected telemetry history
 * never clears this live application configuration.
 *
 * A context with an empty `propertiesConfig` has no standard fields at all: nothing is reserved, so
 * every attribute is customer-defined and `extraInfo` stays unused. Such a context replaces its
 * attributes through {@link setFlatContext} rather than {@link setContext}, which would otherwise
 * treat a customer key named `extraInfo` as the nested extra-attributes store.
 */
export class ContextManager<T extends { extraInfo?: Context } = Context> {
  private standardFields: Context = {};
  private extraInfo: Context = {};

  constructor(
    private readonly name: string,
    private readonly propertiesConfig: PropertiesConfig = {},
    private readonly onChange: (context: Context | undefined) => void = () => undefined
  ) {}

  /**
   * Returns the flat context (standard fields plus extra attributes). Used by format hooks to
   * inject into events. Standard fields take precedence when a key appears in both stores.
   */
  getContext(): Context {
    return this.getCurrentContext();
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
    const candidate = pickNonNullish(standardFields);
    if (!this.validateProperties(candidate)) return;

    this.standardFields = candidate;
    this.extraInfo = this.filterReservedKeys(extraInfo ?? {});
    this.notifyChange();
  }

  /**
   * Merges custom attributes into `extraInfo`, leaving the standard fields untouched. Only applies
   * when the current standard fields are valid: a context with a required field (account needs an
   * `id`) is a no-op until that field is set, while a context with no required field (user) accepts
   * attributes freely — even before any identity is set, so the backend can derive the id from
   * `anonymous_id`. Standard keys are excluded from `extraInfo`, so this cannot change
   * `id`/`name`/`email`. Passing `null` for a custom attribute removes it, matching the mobile SDKs.
   */
  addExtraInfo(extraInfo: Context): void {
    if (!this.validateProperties(this.standardFields)) return;
    this.extraInfo = mergeExtraInfo(this.extraInfo, this.filterReservedKeys(extraInfo));
    this.notifyChange();
  }

  /**
   * Replaces the whole context with flat attributes, for contexts that have no nested "info" shape.
   * Unlike {@link setContext} it treats `extraInfo` as an ordinary key, so a customer attribute of
   * that name is kept instead of being unwrapped into the extra-attributes store.
   */
  protected setFlatContext(context: Context): void {
    this.standardFields = pickNonNullish(deepClone(context));
    this.extraInfo = {};
    this.notifyChange();
  }

  /**
   * Sets a single property, leaving the rest of the context untouched. Writes to the same store as
   * {@link setContext} so the two stay consistent. Kept `protected`: per-property setters are only
   * meaningful for a context with no standard fields, and were deliberately not exposed on user and
   * account.
   */
  protected setProperty(key: string, value: unknown): void {
    this.standardFields = pickNonNullish({ ...this.standardFields, [key]: deepClone(value) });
    this.notifyChange();
  }

  /** Removes a single property set through {@link setContext} or {@link setProperty}. */
  protected removeProperty(key: string): void {
    const candidate = { ...this.standardFields };
    delete candidate[key];
    this.standardFields = candidate;
    this.notifyChange();
  }

  clearContext(): void {
    this.standardFields = {};
    this.extraInfo = {};
    this.notifyChange();
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
        display.warn(`The property "${key}" of ${this.name} is required; the context will not be updated.`);
        return false;
      }

      if (type === 'string' && isValuePresent(value) && typeof value !== 'string') {
        display.warn(`The property "${key}" of ${this.name} must be a string; the context will not be updated.`);
        return false;
      }
    }
    return true;
  }

  private getCurrentContext(): Context {
    return combine(this.extraInfo, this.standardFields);
  }

  private filterReservedKeys(extraInfo: Context): Context {
    const filtered = deepClone(extraInfo);
    for (const key of Object.keys(this.propertiesConfig)) {
      delete filtered[key];
    }
    return filtered;
  }

  private notifyChange(): void {
    this.onChange(this.isEmpty() ? undefined : deepClone(this.getCurrentContext()));
  }
}

export function toSpanMeta(prefix: 'usr' | 'account', context: Context): Record<string, string> {
  const meta: Record<string, string> = {};
  for (const [key, value] of Object.entries(context)) {
    const metaValue = toSpanMetaValue(value);
    if (metaValue !== undefined) {
      meta[`${prefix}.${key}`] = metaValue;
    }
  }
  return meta;
}

function toSpanMetaValue(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string') return value;

  try {
    const json = JSON.stringify(value);
    return typeof json === 'string' ? json : undefined;
  } catch {
    display.warn('Span tag value could not be serialized and will be skipped:', value);
    return undefined;
  }
}

function isValuePresent(value: unknown): boolean {
  return value !== undefined && value !== null && value !== '';
}

function mergeExtraInfo(current: Context, extraInfo: Context): Context {
  const next = deepClone(current);
  for (const [key, value] of Object.entries(deepClone(extraInfo))) {
    if (value === null) {
      delete next[key];
    } else if (value !== undefined) {
      next[key] = value;
    }
  }
  return next;
}

/**
 * Filters out entries whose value is `undefined` or `null`, so unset optional standard fields are
 * not stored with values that violate their schema types.
 *
 * @param context - The object to filter.
 * @returns A shallow copy of `context` keeping only non-nullish entries.
 */
function pickNonNullish(context: Context): Context {
  const result: Context = {};
  for (const [key, value] of Object.entries(context)) {
    if (value !== undefined && value !== null) result[key] = value;
  }
  return result;
}
