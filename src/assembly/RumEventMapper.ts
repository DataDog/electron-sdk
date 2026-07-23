import { isEmptyObject, objectEntries, sanitize } from '@datadog/browser-core';
import { deepClone, getType, isIndexableObject } from '@datadog/js-core/util';
import type { RumBeforeSend } from '../config';
import type { MainRumEvent } from '../domain/rum';
import { display } from '../tools/display';

type ModifiableFieldType = 'string' | 'object';
type ModifiableFieldPaths = Record<string, ModifiableFieldType>;

const COMMON_MAIN_MODIFIABLE_FIELD_PATHS: ModifiableFieldPaths = {
  'view.name': 'string',
  'view.url': 'string',
  service: 'string',
  version: 'string',
};

const MODIFIABLE_FIELD_PATHS_BY_EVENT: Record<MainRumEvent['type'], ModifiableFieldPaths> = {
  view: COMMON_MAIN_MODIFIABLE_FIELD_PATHS,
  error: {
    ...COMMON_MAIN_MODIFIABLE_FIELD_PATHS,
    context: 'object',
    'error.message': 'string',
    'error.stack': 'string',
  },
  resource: {
    ...COMMON_MAIN_MODIFIABLE_FIELD_PATHS,
    'resource.url': 'string',
  },
  vital: {
    ...COMMON_MAIN_MODIFIABLE_FIELD_PATHS,
    context: 'object',
  },
};

/** Applies beforeSend filtering and supported field changes to fully assembled main-process RUM events. */
export class RumEventMapper {
  constructor(private readonly beforeSend?: RumBeforeSend) {}

  map(event: MainRumEvent): MainRumEvent | undefined {
    const beforeSend = this.beforeSend;
    if (!beforeSend) {
      return event;
    }

    const modifiableFieldPaths = MODIFIABLE_FIELD_PATHS_BY_EVENT[event.type];
    const result = limitModification(event, modifiableFieldPaths, (modifiableEvent) => {
      if (modifiableFieldPaths.context !== undefined) {
        modifiableEvent.context ??= {};
      }
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
    setValueAtPath(object, clone, fieldPath.split('.'), fieldType)
  );

  return result;
}

function setValueAtPath(object: unknown, clone: unknown, pathSegments: string[], fieldType: ModifiableFieldType): void {
  const [field, ...restPathSegments] = pathSegments;

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
  fieldType: ModifiableFieldType
): void {
  if (object[field] === value) {
    return;
  }

  const newType = getType(value);
  if (newType === fieldType) {
    object[field] = sanitize(value);
  } else if (fieldType === 'object' && (newType === 'undefined' || newType === 'null')) {
    object[field] = {};
  }
}
