import { combine, deepClone } from '@datadog/js-core/util';
import { SKIPPED } from '@datadog/js-core/assembly';
import { type TimeStamp, timeStampNow } from '@datadog/js-core/time';
import { isEmptyObject, sanitize, SANITIZE_DEFAULT_MAX_CHARACTER_COUNT } from '@datadog/browser-core';
import { display } from '../../tools/display';
import { initContextHistory } from './contextHistory';
import type { FormatHooks } from '../../assembly';

export type Context = Record<string, unknown>;

export interface ContextHistory {
  add(value: Context, startTime: TimeStamp): void;
  closeActive(endTime: TimeStamp): void;
  closeAndAdd(value: Context, atTime: TimeStamp): void;
  pruneAndPersist(): void;
  find(startTime: TimeStamp): Context | undefined;
}

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
 * "info" shape and the flat shape sent on events. Keys declared as standard fields are excluded
 * from `extraInfo`, so they can only be set through the validated top-level properties.
 *
 * It owns the cloning and validation concerns shared by every context (user, account, and global
 * context), so each context only needs to register its hook and declare its config.
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
    private readonly history?: ContextHistory
  ) {}

  /**
   * Returns the flat context (standard fields plus extra attributes). Used by format hooks to
   * inject into events. Standard fields take precedence when a key appears in both stores.
   */
  getContext(startTime?: TimeStamp): Context {
    if (startTime !== undefined && this.history) {
      return this.history.find(startTime) ?? {};
    }
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

  /**
   * Registers the format hook that injects this context into RUM events, under `key` when the
   * context is namespaced (`usr`, `account`) or at `context` when it is free-form.
   */
  protected registerRumHook(hooks: FormatHooks, key?: 'usr' | 'account'): void {
    hooks.registerRum(({ eventType, startTime }) => {
      // View updates retain the view's original start time, but should reflect the customer context
      // active when the update is emitted. Other events use history for start-time attribution.
      const context = this.getContext(eventType === 'view' ? undefined : startTime);
      if (isEmptyObject(context)) return SKIPPED;
      return key ? { [key]: context } : { context };
    });
  }

  isEmpty(): boolean {
    return isEmptyObject(this.standardFields) && isEmptyObject(this.extraInfo);
  }

  /** Sanitizes identity and extras before storing them, recording history, or enriching events. */
  setContext(info: T): void {
    const { extraInfo, ...standardFields } = deepClone(info) as Context & { extraInfo?: Context };
    const candidate = pickNonNullish(standardFields);
    if (!this.validateProperties(candidate)) return;

    // Give identity fields their own budgets so large extras cannot remove an id/name/email.
    const sanitized = pickNonNullish(
      Object.fromEntries(Object.entries(candidate).map(([key, value]) => [key, sanitize(value)]))
    );
    if (!this.validateProperties(sanitized)) return;
    this.standardFields = sanitized;
    this.extraInfo = sanitizeExtraInfo(this.filterReservedKeys(extraInfo ?? {}));
    this.recordCurrentContext();
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
    this.recordCurrentContext();
  }

  /**
   * Replaces the whole context with flat attributes, for contexts that have no nested "info" shape.
   * Unlike {@link setContext} it treats `extraInfo` as an ordinary key, so a customer attribute of
   * that name is kept instead of being unwrapped into the extra-attributes store.
   */
  protected setFlatContext(context: Context): void {
    this.standardFields = pickNonNullish(deepClone(context));
    this.extraInfo = {};
    this.recordCurrentContext();
  }

  /**
   * Sets a single property, leaving the rest of the context untouched. Writes to the same store as
   * {@link setContext} so the two stay consistent. Kept `protected`: per-property setters are only
   * meaningful for a context with no standard fields, and were deliberately not exposed on user and
   * account.
   */
  protected setProperty(key: string, value: unknown): void {
    this.standardFields = pickNonNullish({ ...this.standardFields, [key]: deepClone(value) });
    this.recordCurrentContext();
  }

  /** Removes a single property set through {@link setContext} or {@link setProperty}. */
  protected removeProperty(key: string): void {
    const candidate = { ...this.standardFields };
    delete candidate[key];
    this.standardFields = candidate;
    this.recordCurrentContext();
  }

  clearContext(): void {
    this.standardFields = {};
    this.extraInfo = {};
    this.recordCurrentContext();
  }

  /**
   * Validates that required properties are present and that constrained properties have the right
   * format and fit their character budget. Returns `false` (and warns) when the candidate is invalid,
   * so the caller keeps the previous context.
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

      // Check before sanitize() so both identities reject the whole update without logging the value.
      if (
        type === 'string' &&
        typeof value === 'string' &&
        JSON.stringify(value).length > SANITIZE_DEFAULT_MAX_CHARACTER_COUNT
      ) {
        display.warn(
          `The property "${key}" of ${this.name} exceeds the context size limit; the context will not be updated.`
        );
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

  private recordCurrentContext(): void {
    if (!this.history) return;

    const now = timeStampNow();
    if (this.isEmpty()) {
      this.history.closeActive(now);
      this.history.pruneAndPersist();
    } else {
      this.history.closeAndAdd(deepClone(this.getCurrentContext()), now);
    }
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

/**
 * Creates a context instance with a disk-backed crash-attribution history.
 * Extracts the shared history initialization boilerplate from each context subclass.
 */
export async function initContextWithHistory<T>(
  construct: (history: ContextHistory) => T,
  historyFileName: string
): Promise<T> {
  const history = await initContextHistory(historyFileName);
  return construct(history);
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
  const next = { ...current };
  for (const [key, value] of Object.entries(extraInfo)) {
    if (value === null) delete next[key];
  }
  return sanitizeExtraInfo(pickNonNullish(extraInfo), next);
}

function sanitizeExtraInfo(extraInfo: Context, current: Context = {}): Context {
  let next = { ...current };
  let skipped = false;
  // Sanitize without truncation, then budget complete attributes so an oversized update cannot
  // remove an existing value or unrelated keys. Only the bounded result is stored in history.
  const sanitized = sanitize(extraInfo, Infinity) as Context;
  // Reclaim space from shrinking replacements before considering additions, regardless of key order.
  for (const [key, value] of Object.entries(sanitized)) {
    const previous = current[key];
    if (
      value !== undefined &&
      previous !== undefined &&
      Object.prototype.hasOwnProperty.call(current, key) &&
      JSON.stringify(value).length <= JSON.stringify(previous).length
    ) {
      next[key] = value;
    }
  }
  for (const [key, value] of Object.entries(sanitized)) {
    if (value === undefined || value === next[key]) continue;
    const candidate = { ...next, [key]: value };
    if (JSON.stringify(candidate).length > SANITIZE_DEFAULT_MAX_CHARACTER_COUNT) {
      skipped = true;
    } else {
      next = candidate;
    }
  }
  if (skipped) display.warn('Extra-info attributes exceeding the context size limit were ignored.');
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
