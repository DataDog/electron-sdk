import { isEmptyObject, objectEntries, sanitize } from '@datadog/browser-core';
import { deepClone, getType, isIndexableObject } from '@datadog/js-core/util';
import type { RumBeforeSend } from '../config';
import type { RumEvent } from '../domain/rum';
import { display } from '../tools/display';

type ModifiableFieldPaths = Record<string, 'string' | 'object' | 'array'>;

const COMMON_MODIFIABLE_FIELD_PATHS: ModifiableFieldPaths = {
  'view.name': 'string',
  'view.url': 'string',
  'view.referrer': 'string',
  context: 'object',
  service: 'string',
  version: 'string',
};

const MODIFIABLE_FIELD_PATHS_BY_EVENT: Record<RumEvent['type'], ModifiableFieldPaths> = {
  view: {
    ...COMMON_MODIFIABLE_FIELD_PATHS,
    'view.performance.lcp.resource_url': 'string',
  },
  error: {
    ...COMMON_MODIFIABLE_FIELD_PATHS,
    'error.message': 'string',
    'error.stack': 'string',
    'error.handling_stack': 'string',
    'error.resource.url': 'string',
    'error.fingerprint': 'string',
    '_dd.debug_ids': 'array',
  },
  resource: {
    ...COMMON_MODIFIABLE_FIELD_PATHS,
    'resource.url': 'string',
    'resource.graphql.variables': 'string',
    'resource.request.headers': 'object',
    'resource.response.headers': 'object',
    'resource.websocket.close_reason': 'string',
  },
  action: {
    ...COMMON_MODIFIABLE_FIELD_PATHS,
    'action.target.name': 'string',
  },
  long_task: {
    ...COMMON_MODIFIABLE_FIELD_PATHS,
    'long_task.scripts[].source_url': 'string',
    'long_task.scripts[].invoker': 'string',
    '_dd.debug_ids': 'array',
  },
  vital: COMMON_MODIFIABLE_FIELD_PATHS,
  transition: COMMON_MODIFIABLE_FIELD_PATHS,
  view_update: COMMON_MODIFIABLE_FIELD_PATHS,
};

/**
 * Applies beforeSend after RUM events have been fully assembled. Customer changes are isolated in a clone,
 * then only supported fields are sanitized and copied back. Filtering fails open for callback errors,
 * and view or crash events remain protected.
 */
export class RumEventMapper {
  constructor(private readonly beforeSend?: RumBeforeSend) {}

  map(event: RumEvent): RumEvent | undefined {
    const beforeSend = this.beforeSend;
    // Internal view updates bypass beforeSend.
    if (!beforeSend || event.type === 'view_update') {
      return event;
    }

    event.context ??= {};
    // Unknown event types only expose common modifiable fields.
    const modifiableFieldPaths = MODIFIABLE_FIELD_PATHS_BY_EVENT[event.type] ?? COMMON_MODIFIABLE_FIELD_PATHS;
    const result = limitModification(event, modifiableFieldPaths, (modifiableEvent) => {
      try {
        return beforeSend(modifiableEvent);
      } catch (error) {
        display.error('beforeSend threw an error:', error);
        return undefined;
      }
    });

    if (event.context && isEmptyObject(event.context)) {
      delete event.context;
    }

    if (result !== false) {
      return event;
    }
    if (event.type === 'view') {
      display.warn("Can't dismiss view events using beforeSend!");
      return event;
    }
    if (event.type === 'error' && event.error.is_crash) {
      display.warn("Can't dismiss crash events using beforeSend!");
      return event;
    }
    return undefined;
  }
}

function limitModification<T extends Record<string, unknown>, Result>(
  object: T,
  modifiableFieldPaths: ModifiableFieldPaths,
  modifier: (object: T) => Result
): Result {
  const clone = deepClone(object);
  const result = modifier(clone);

  objectEntries(modifiableFieldPaths).forEach(([fieldPath, fieldType]) =>
    setValueAtPath(object, clone, fieldPath.split(/\.|(?=\[\])/), fieldType)
  );

  return result;
}

function setValueAtPath(
  object: unknown,
  clone: unknown,
  pathSegments: string[],
  fieldType: 'string' | 'object' | 'array'
): void {
  const [field, ...restPathSegments] = pathSegments;

  if (field === '[]') {
    if (Array.isArray(object) && Array.isArray(clone)) {
      object.forEach((item, index) => setValueAtPath(item, clone[index], restPathSegments, fieldType));
    }
    return;
  }

  if (!isIndexableObject(object) || !isIndexableObject(clone)) {
    return;
  }
  if (restPathSegments.length > 0) {
    setValueAtPath(object[field], clone[field], restPathSegments, fieldType);
    return;
  }

  setNestedValue(object, field, clone[field], fieldType);
}

function setNestedValue(
  object: Record<string, unknown>,
  field: string,
  value: unknown,
  fieldType: 'string' | 'object' | 'array'
): void {
  if (object[field] === value) {
    return;
  }

  const newType = getType(value);
  if (newType === fieldType) {
    object[field] = sanitize(value);
  } else if (fieldType === 'object' && (newType === 'undefined' || newType === 'null')) {
    object[field] = {};
  } else if (fieldType === 'array' && (newType === 'undefined' || newType === 'null')) {
    object[field] = [];
  }
}
