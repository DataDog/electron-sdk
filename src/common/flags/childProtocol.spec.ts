import { describe, it, expect } from 'vitest';
import {
  contextRequestMessage,
  contextResponseMessage,
  decodeFrame,
  encodeFrame,
  evaluationsMessage,
  helloMessage,
  isChildMessage,
  MAX_FRAME_LENGTH,
  snapshotMessage,
  type ChildMessage,
} from './childProtocol';

const ALL_MESSAGES: ChildMessage[] = [
  helloMessage(),
  snapshotMessage('{"revision":1}'),
  evaluationsMessage('{"records":[]}'),
  contextRequestMessage(7, '{"targetingKey":"user"}'),
  contextResponseMessage(7, true, 3),
  contextResponseMessage(8, false),
];

describe('childProtocol', () => {
  it('recognizes only the namespaced key with version 1 and a known type', () => {
    for (const message of ALL_MESSAGES) {
      expect(isChildMessage(message)).toBe(true);
    }
    expect(isChildMessage({ __ddElectronSdkFlags: 1, type: 'unknown' })).toBe(false);
    expect(isChildMessage({ __ddElectronSdkFlags: 2, type: 'hello' })).toBe(false);
    expect(isChildMessage({ ddElectronSdkFlags: 1, type: 'hello' })).toBe(false);
  });

  it('ignores foreign shapes: a Vitrine-style { id, method, params } request, null, strings, arrays, other versions', () => {
    for (const foreign of [
      { id: 1, method: 'evaluate', params: {} },
      { type: 'dd-flags', frame: 'x' },
      null,
      undefined,
      'hello',
      42,
      [helloMessage()],
      { __ddElectronSdkFlags: '1', type: 'hello' },
      { __ddElectronSdkFlags: 1.5, type: 'hello' },
    ]) {
      expect(isChildMessage(foreign)).toBe(false);
    }
  });

  it('every message survives JSON and structured-clone round trips unchanged', () => {
    for (const message of ALL_MESSAGES) {
      const viaJson = JSON.parse(JSON.stringify(message)) as unknown;
      const viaClone = structuredClone(message);
      expect(viaJson).toEqual(message);
      expect(viaClone).toEqual(message);
      expect(isChildMessage(viaJson)).toBe(true);
      expect(isChildMessage(viaClone)).toBe(true);
    }
  });

  it('frames encode to strings and decode back; non-string or oversize frames decode to undefined before parsing', () => {
    for (const message of ALL_MESSAGES) {
      const frame = encodeFrame(message);
      expect(typeof frame).toBe('string');
      expect(decodeFrame(frame)).toEqual(message);
    }
    expect(decodeFrame(helloMessage())).toBeUndefined();
    expect(decodeFrame(undefined)).toBeUndefined();
    expect(decodeFrame('{not json')).toBeUndefined();
    expect(decodeFrame(JSON.stringify({ id: 1, method: 'ping' }))).toBeUndefined();
    const oversize = `${encodeFrame(snapshotMessage(''))}${' '.repeat(MAX_FRAME_LENGTH)}`;
    const parse = JSON.parse;
    let parsed = false;
    JSON.parse = ((text: string) => {
      parsed = true;
      return parse(text) as unknown;
    }) as typeof JSON.parse;
    try {
      expect(decodeFrame(oversize)).toBeUndefined();
      expect(parsed).toBe(false);
    } finally {
      JSON.parse = parse;
    }
  });

  it('rejects a context-request id that is not a safe integer and payloads that are not strings', () => {
    const base = { __ddElectronSdkFlags: 1, type: 'context-request', payload: '{}' };
    for (const id of [1.5, Number.MAX_SAFE_INTEGER + 1, '1', undefined, Number.NaN]) {
      expect(isChildMessage({ ...base, id })).toBe(false);
    }
    expect(isChildMessage({ ...base, id: 1, payload: { targetingKey: 'x' } })).toBe(false);
    expect(isChildMessage({ __ddElectronSdkFlags: 1, type: 'snapshot', payload: 42 })).toBe(false);
    expect(isChildMessage({ __ddElectronSdkFlags: 1, type: 'evaluations' })).toBe(false);
    expect(isChildMessage({ __ddElectronSdkFlags: 1, type: 'context-response', id: 1, accepted: 'yes' })).toBe(false);
    expect(
      isChildMessage({ __ddElectronSdkFlags: 1, type: 'context-response', id: 1, accepted: true, contextRevision: 1.2 })
    ).toBe(false);
  });
});
