import { isIndexableObject } from '@datadog/js-core/util';

/**
 * Feature flags protocol between main and spawned processes (D17, §10.2). Messages are
 * JSON-safe envelopes namespaced by `__ddElectronSdkFlags: 1`, carried on SDK-owned ports
 * or encoded as string frames the app routes. Anything else, including another protocol
 * version, is not an SDK message and is ignored silently. Internal: never exported.
 */
export const CHILD_PROTOCOL_KEY = '__ddElectronSdkFlags';
export const CHILD_PROTOCOL_VERSION = 1;
/** Frames are checked against this length before parsing (D22). */
export const MAX_FRAME_LENGTH = 9 * 1024 * 1024;
/** Context request payloads are checked against this length before parsing (D20). */
export const MAX_CONTEXT_REQUEST_LENGTH = 512 * 1024;

interface Envelope<T extends string> {
  __ddElectronSdkFlags: 1;
  type: T;
}

export type HelloMessage = Envelope<'hello'>;
export type SnapshotMessage = Envelope<'snapshot'> & { payload: string };
export type EvaluationsMessage = Envelope<'evaluations'> & { payload: string };
export type ContextRequestMessage = Envelope<'context-request'> & { id: number; payload: string };
export type ContextResponseMessage = Envelope<'context-response'> & {
  id: number;
  accepted: boolean;
  contextRevision?: number;
};

export type ChildMessage =
  HelloMessage | SnapshotMessage | EvaluationsMessage | ContextRequestMessage | ContextResponseMessage;

/** Whether a value is an SDK envelope with protocol version 1 and a well-formed known type. */
export function isChildMessage(value: unknown): value is ChildMessage {
  if (!isIndexableObject(value) || Array.isArray(value) || value[CHILD_PROTOCOL_KEY] !== CHILD_PROTOCOL_VERSION) {
    return false;
  }
  switch (value.type) {
    case 'hello':
      return true;
    case 'snapshot':
    case 'evaluations':
      return typeof value.payload === 'string';
    case 'context-request':
      return Number.isSafeInteger(value.id) && typeof value.payload === 'string';
    case 'context-response':
      return (
        Number.isSafeInteger(value.id) &&
        typeof value.accepted === 'boolean' &&
        (value.contextRevision === undefined || Number.isSafeInteger(value.contextRevision))
      );
    default:
      return false;
  }
}

/** Encode a message as a string frame for app-routed channels. */
export function encodeFrame(message: ChildMessage): string {
  return JSON.stringify(message);
}

/**
 * Decode a frame: `undefined` for a non-string, a frame longer than `maxLength` (checked
 * before parsing), invalid JSON or anything that is not an SDK envelope.
 */
export function decodeFrame(frame: unknown, maxLength = MAX_FRAME_LENGTH): ChildMessage | undefined {
  if (typeof frame !== 'string' || frame.length > maxLength) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(frame);
  } catch {
    return undefined;
  }
  return isChildMessage(parsed) ? parsed : undefined;
}

export const helloMessage = (): HelloMessage => ({ __ddElectronSdkFlags: 1, type: 'hello' });

export const snapshotMessage = (payload: string): SnapshotMessage => ({
  __ddElectronSdkFlags: 1,
  type: 'snapshot',
  payload,
});

export const evaluationsMessage = (payload: string): EvaluationsMessage => ({
  __ddElectronSdkFlags: 1,
  type: 'evaluations',
  payload,
});

export const contextRequestMessage = (id: number, payload: string): ContextRequestMessage => ({
  __ddElectronSdkFlags: 1,
  type: 'context-request',
  id,
  payload,
});

export const contextResponseMessage = (
  id: number,
  accepted: boolean,
  contextRevision?: number
): ContextResponseMessage => ({
  __ddElectronSdkFlags: 1,
  type: 'context-response',
  id,
  accepted,
  ...(contextRevision !== undefined ? { contextRevision } : {}),
});
