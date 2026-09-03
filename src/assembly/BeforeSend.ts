import { isEmptyObject, objectEntries, sanitize } from '@datadog/browser-core';
import { deepClone, getType } from '@datadog/js-core/util';
import type { ElectronEventSource, RumBeforeSend } from '../config';
import type { RumEvent } from '../domain/rum';
import { display } from '../tools/display';

type ModifiableFieldType = 'string' | 'object' | 'array';
type ModifiableFieldPaths = Record<string, ModifiableFieldType>;

const COMMON_MODIFIABLE_FIELD_PATHS: ModifiableFieldPaths = {
  'view.name': 'string',
  'view.url': 'string',
  'view.referrer': 'string',
  service: 'string',
  version: 'string',
  context: 'object',
};

// TODO(RUM-18372): Share this mapping with the Browser SDK.
// Keep aligned with the Browser SDK beforeSend mapping:
// https://github.com/DataDog/browser-sdk/blob/main/packages/browser-rum-core/src/domain/assembly.ts
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
    'resource.websocket.protocol': 'string',
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

/** Applies beforeSendRum filtering and supported field changes to fully assembled RUM events. */
export class BeforeSend {
  constructor(private readonly beforeSendRum?: RumBeforeSend) {}

  apply<T extends RumEvent>(event: T, source: ElectronEventSource): T | undefined {
    const beforeSendRum = this.beforeSendRum;
    if (!beforeSendRum) {
      return event;
    }

    const modifiableFieldPaths = MODIFIABLE_FIELD_PATHS_BY_EVENT[event.type] ?? COMMON_MODIFIABLE_FIELD_PATHS;
    const result = limitModification(event, modifiableFieldPaths, (modifiableEvent) => {
      modifiableEvent.context ??= {};
      try {
        return beforeSendRum(modifiableEvent, { source });
      } catch (error) {
        display.error('beforeSendRum threw an error:', error);
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
      display.warn("Can't dismiss view events using beforeSendRum!");
      return event;
    }
    // Match mobile SDKs: native crashes may be scrubbed, but are never discarded to preserve the fatal report.
    if (event.type === 'error' && event.error.is_crash) {
      display.warn("Can't dismiss crash events using beforeSendRum!");
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

function setValueAtPath(object: unknown, clone: unknown, pathSegments: string[], fieldType: ModifiableFieldType): void {
  const [field, ...restPathSegments] = pathSegments;

  if (field === '[]') {
    if (Array.isArray(object) && Array.isArray(clone)) {
      object.forEach((item, index) => setValueAtPath(item, clone[index], restPathSegments, fieldType));
    }
    return;
  }

  if (!isValidObject(object) || !isValidObject(clone)) {
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
  } else if (fieldType === 'array' && (newType === 'undefined' || newType === 'null')) {
    object[field] = [];
  }
}

function isValidObject(object: unknown): object is Record<string, unknown> {
  return getType(object) === 'object';
}
