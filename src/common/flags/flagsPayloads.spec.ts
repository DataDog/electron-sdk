import { describe, it, expect } from 'vitest';
import {
  parseFlagsSnapshot,
  parseEvaluationBatch,
  MAX_BATCH_RECORDS,
  MAX_BATCH_ERROR_MESSAGE_LENGTH,
  utf8ByteLength,
} from './flagsPayloads';
import type { FlagsSnapshot } from './types';
import { precomputedSnapshot } from './precomputedCases.specUtil';

const fullSnapshot: FlagsSnapshot = {
  revision: 3,
  status: 'READY',
  configuration: '{"version":1,"rules":{"response":""}}',
  context: { targetingKey: 'user-1', plan: 'pro' },
  contextRevision: 2,
  configurationRevision: 1,
  tracking: { exposures: true, rum: true, evaluations: true },
};

describe('parseFlagsSnapshot', () => {
  it('parses a valid snapshot', () => {
    expect(parseFlagsSnapshot(JSON.stringify(fullSnapshot))).toEqual(fullSnapshot);
  });

  it('accepts a precomputed configuration string unchanged (opaque, M7)', () => {
    const snapshot = precomputedSnapshot();
    // The payloads layer treats the wire string as opaque: whatever precomputed
    // assignments serialize to round-trips without validation or transformation.
    expect(parseFlagsSnapshot(JSON.stringify(snapshot))).toEqual(snapshot);
  });

  it('accepts the minimal pre-init and disabled snapshot shapes (no configuration or context)', () => {
    const minimal = {
      revision: 0,
      status: 'NOT_READY',
      contextRevision: 0,
      configurationRevision: 0,
      tracking: { exposures: false, rum: false, evaluations: false },
    };
    expect(parseFlagsSnapshot(JSON.stringify(minimal))).toEqual(minimal);
    const disabled = { ...minimal, status: 'DISABLED' as const };
    expect(parseFlagsSnapshot(JSON.stringify(disabled))).toEqual(disabled);
  });
  it('accepts a pending-identity NOT_READY invalidation and rejects contexts on minimal shapes otherwise', () => {
    // The invalidation: revision >= 1, the new context, no configuration.
    const invalidation = {
      revision: 3,
      status: 'NOT_READY',
      context: { targetingKey: 'user-2' },
      contextRevision: 2,
      configurationRevision: 1,
      tracking: { exposures: true, rum: true, evaluations: true },
    };
    expect(parseFlagsSnapshot(JSON.stringify(invalidation))).toEqual(invalidation);
    // The pre-init privacy contract: a context never rides a revision-0 minimal snapshot.
    expect(parseFlagsSnapshot(JSON.stringify({ ...invalidation, revision: 0 }))).toBeUndefined();
    // DISABLED never carries a context, at any revision.
    expect(parseFlagsSnapshot(JSON.stringify({ ...invalidation, status: 'DISABLED' }))).toBeUndefined();
    // An invalidation never carries a configuration or an error message.
    expect(parseFlagsSnapshot(JSON.stringify({ ...invalidation, configuration: 'wire' }))).toBeUndefined();
    expect(parseFlagsSnapshot(JSON.stringify({ ...invalidation, errorMessage: 'boom' }))).toBeUndefined();
    // The invalidation context must be flat.
    expect(
      parseFlagsSnapshot(JSON.stringify({ ...invalidation, context: { targetingKey: 'u', nested: {} } }))
    ).toBeUndefined();
  });

  it('rejects a minimal-status snapshot that carries a configuration or context', () => {
    const withConfiguration = { ...fullSnapshot, revision: 0, status: 'NOT_READY' as const };
    expect(parseFlagsSnapshot(JSON.stringify(withConfiguration))).toBeUndefined();
    const withContext = { ...fullSnapshot, revision: 0, status: 'DISABLED' as const, configuration: undefined };
    expect(parseFlagsSnapshot(JSON.stringify(withContext))).toBeUndefined();
  });

  it('rejects snapshots with missing revision, unknown status, non-string configuration or invalid tracking', () => {
    expect(parseFlagsSnapshot(JSON.stringify({ ...fullSnapshot, revision: undefined }))).toBeUndefined();
    expect(parseFlagsSnapshot(JSON.stringify({ ...fullSnapshot, status: 'WAT' }))).toBeUndefined();
    expect(parseFlagsSnapshot(JSON.stringify({ ...fullSnapshot, configuration: 42 }))).toBeUndefined();
    expect(parseFlagsSnapshot(JSON.stringify({ ...fullSnapshot, tracking: { exposures: true } }))).toBeUndefined();
    expect(
      parseFlagsSnapshot(
        JSON.stringify({ ...fullSnapshot, tracking: { exposures: 'yes', rum: true, evaluations: true } })
      )
    ).toBeUndefined();
    expect(parseFlagsSnapshot('not json')).toBeUndefined();
    expect(parseFlagsSnapshot(JSON.stringify([fullSnapshot]))).toBeUndefined();
  });
});

const validRecord = {
  flagKey: 'my-flag',
  variant: 'on',
  allocationKey: 'alloc-1',
  reason: 'SPLIT',
  doLog: true,
  serialId: 3,
  configurationId: 'abc',
  contextRevision: 2,
  timestamp: 1234567890,
  viewId: 'view-1',
  viewUrl: 'electron://main',
};

describe('parseEvaluationBatch', () => {
  it('rejects a batch that is not a string, exceeds maxLength before parsing, is not JSON or has no records array', () => {
    expect(parseEvaluationBatch(42 as unknown as string, 1000)).toBeUndefined();
    expect(parseEvaluationBatch('x'.repeat(1001), 1000)).toBeUndefined();
    expect(parseEvaluationBatch('{not json', 1000)).toBeUndefined();
    expect(parseEvaluationBatch(JSON.stringify({ records: 'nope' }), 1000)).toBeUndefined();
    expect(parseEvaluationBatch(JSON.stringify({}), 1000)).toBeUndefined();
  });

  it('bounds the batch in UTF-8 bytes, not UTF-16 units (R4)', () => {
    // '€' is 3 UTF-8 bytes and 1 UTF-16 unit: this payload is far below the limit in .length.
    const multibyte = JSON.stringify({ records: [{ ...validRecord, variant: '€'.repeat(200) }] });
    const bytes = Buffer.byteLength(multibyte, 'utf8');
    expect(multibyte.length).toBeLessThan(bytes - 100);
    expect(parseEvaluationBatch(multibyte, bytes - 1)).toBeUndefined();
    expect(parseEvaluationBatch(multibyte, multibyte.length)).toBeUndefined();
    expect(parseEvaluationBatch(multibyte, bytes)?.batch.records).toHaveLength(1);
  });

  it('counts astral characters (surrogate pairs) as 4 bytes when bounding a batch (R4)', () => {
    const astral = JSON.stringify({ records: [{ ...validRecord, flagKey: '🚩'.repeat(100) }] });
    const bytes = Buffer.byteLength(astral, 'utf8');
    expect(parseEvaluationBatch(astral, bytes - 1)).toBeUndefined();
    expect(parseEvaluationBatch(astral, bytes)?.batch.records).toHaveLength(1);
  });

  it('adds the sender-reported droppedCount for records it dropped before sending (R4)', () => {
    const result = parseEvaluationBatch(JSON.stringify({ records: [validRecord], droppedCount: 2 }), 1024 * 1024);
    expect(result?.droppedCount).toBe(2);
    expect(parseEvaluationBatch(JSON.stringify({ records: [], droppedCount: -1 }), 1024)?.droppedCount).toBe(0);
    expect(parseEvaluationBatch(JSON.stringify({ records: [], droppedCount: 'x' }), 1024)?.droppedCount).toBe(0);
  });

  it('keeps the first 100 records of a batch with more and reports the remainder in droppedCount', () => {
    const records = Array.from({ length: 130 }, () => ({ ...validRecord }));
    const result = parseEvaluationBatch(JSON.stringify({ records }), 1024 * 1024);
    expect(result?.batch.records).toHaveLength(MAX_BATCH_RECORDS);
    expect(result?.droppedCount).toBe(30);
  });

  it('keeps valid records, drops invalid ones and reports droppedCount', () => {
    const records = [
      validRecord,
      { ...validRecord, flagKey: 42 },
      { ...validRecord, doLog: 'yes' },
      { ...validRecord, timestamp: 'now' },
    ];
    const result = parseEvaluationBatch(JSON.stringify({ records }), 1024 * 1024);
    expect(result?.batch.records).toEqual([validRecord]);
    expect(result?.droppedCount).toBe(3);
  });

  it('truncates viewUrl and drops records whose flagKey or variant exceeds the limit', () => {
    const longUrl = { ...validRecord, viewUrl: 'https://example.com/' + 'a'.repeat(3000) };
    const longFlagKey = { ...validRecord, flagKey: 'f'.repeat(257) };
    const longVariant = { ...validRecord, variant: 'v'.repeat(257) };
    const result = parseEvaluationBatch(JSON.stringify({ records: [longUrl, longFlagKey, longVariant] }), 1024 * 1024);
    expect(result?.batch.records).toHaveLength(1);
    expect(result?.batch.records[0].viewUrl).toHaveLength(2048);
    expect(result?.droppedCount).toBe(2);
  });

  it('keeps at most 5 errors with messages and stacks truncated to 1024', () => {
    const errors = Array.from({ length: 7 }, () => ({
      message: 'm'.repeat(1200),
      stack: 's'.repeat(1200),
    }));
    const result = parseEvaluationBatch(JSON.stringify({ records: [validRecord], errors }), 1024 * 1024);
    expect(result?.batch.errors).toHaveLength(5);
    for (const error of result?.batch.errors ?? []) {
      expect(error.message).toHaveLength(MAX_BATCH_ERROR_MESSAGE_LENGTH);
      expect(error.stack).toHaveLength(MAX_BATCH_ERROR_MESSAGE_LENGTH);
    }
  });
});

describe('utf8ByteLength', () => {
  it.each([
    ['ascii', 'plain-flag_1'],
    ['two-byte', 'café ñ'],
    ['three-byte', '€ 中文'],
    ['astral', '🚩👍🏽'],
    ['lone surrogates', '\ud800x\udc00'],
    ['mixed', 'a€🚩é\u0000\u007f\u0080\u07ff\u0800\uffff'],
  ])('matches the UTF-8 encoder for %s text', (_label, text) => {
    expect(utf8ByteLength(text)).toBe(Buffer.byteLength(text, 'utf8'));
  });
});
