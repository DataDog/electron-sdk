import { isIndexableObject } from '@datadog/js-core/util';
import type { FlatContext } from './types';

export const FLAGS_MAX_ATTRIBUTES = 100;
export const FLAGS_MAX_ATTRIBUTE_KEY_LENGTH = 256;
export const FLAGS_MAX_ATTRIBUTE_STRING_LENGTH = 4096;

export interface NormalizedFlagsContext {
  context: FlatContext;
  droppedKeys: string[];
}

/**
 * Normalize a user-provided flag context into a flat, primitive-only context.
 *
 * The context is replaced, never merged with a previous one: a logout is expressed
 * by setting `{}` (or a context without a targeting key), which falls back to the
 * anonymous key and drops every prior attribute. Attributes that are not flat
 * primitives, or exceed the size limits, are dropped and reported in `droppedKeys`.
 */
export function normalizeFlagsContext(input: unknown, anonymousKey: string): NormalizedFlagsContext {
  const source = isIndexableObject(input) ? input : {};
  const hasValidTargetingKey = isValidTargetingKey(source.targetingKey);
  const context: FlatContext = {
    targetingKey: hasValidTargetingKey ? (source.targetingKey as string) : anonymousKey,
  };
  const droppedKeys: string[] = [];
  let attributeCount = 0;
  for (const key of Object.keys(source)) {
    if (key === 'targetingKey') {
      if (!hasValidTargetingKey) {
        droppedKeys.push('targetingKey');
      }
      continue;
    }
    const value = source[key];
    if (attributeCount >= FLAGS_MAX_ATTRIBUTES) {
      droppedKeys.push(key);
      continue;
    }
    if (key.length > FLAGS_MAX_ATTRIBUTE_KEY_LENGTH) {
      droppedKeys.push(key);
      continue;
    }
    if (typeof value === 'string') {
      if (value.length > FLAGS_MAX_ATTRIBUTE_STRING_LENGTH) {
        droppedKeys.push(key);
        continue;
      }
      context[key] = value;
      attributeCount += 1;
    } else if (typeof value === 'number') {
      if (!Number.isFinite(value)) {
        droppedKeys.push(key);
        continue;
      }
      context[key] = value;
      attributeCount += 1;
    } else if (typeof value === 'boolean') {
      context[key] = value;
      attributeCount += 1;
    } else {
      droppedKeys.push(key);
    }
  }
  return { context, droppedKeys };
}

/** A targeting key must be a non-empty string within the attribute string length limit (D1c). */
function isValidTargetingKey(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= FLAGS_MAX_ATTRIBUTE_STRING_LENGTH;
}

export type { FlatContext };
