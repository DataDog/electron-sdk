import { describe, it, expect } from 'vitest';
import type { TimeStamp } from '@datadog/js-core/time';
import { EvaluationReporter, MAX_BATCH_BYTES, MAX_RECORDS_PER_BATCH } from './EvaluationReporter';
import { parseEvaluationBatch } from './flagsPayloads';
import type { EvaluationBatch, EvaluationRecord } from './types';

function createReporter() {
  const sent: string[] = [];
  const reporter = new EvaluationReporter({
    send: (json) => sent.push(json),
    setTimeout: () => 1,
    clearTimeout: () => undefined,
  });
  reporter.setTracking({ exposures: true, rum: false, evaluations: true });
  return { reporter, sent };
}

const record = (overrides: Partial<EvaluationRecord> = {}): EvaluationRecord => ({
  flagKey: 'flag',
  variant: 'on',
  reason: 'TARGETING_MATCH',
  doLog: true,
  contextRevision: 1,
  timestamp: 1 as TimeStamp,
  ...overrides,
});

const utf8 = (json: string) => Buffer.byteLength(json, 'utf8');

describe('EvaluationReporter batch bound (R4)', () => {
  it('keeps every sent envelope within 64 KiB of UTF-8 bytes with multibyte records, and loses none', () => {
    const { reporter, sent } = createReporter();
    // 3-byte characters: each record is ~3x larger in bytes than in UTF-16 units.
    for (let index = 0; index < 90; index += 1) {
      reporter.add(record({ flagKey: `${index}-${'€'.repeat(250)}`, viewUrl: `app://w/${'中'.repeat(400)}` }));
    }
    reporter.flush();
    expect(sent.length).toBeGreaterThan(1);
    for (const json of sent) {
      expect(utf8(json)).toBeLessThanOrEqual(MAX_BATCH_BYTES);
      expect((JSON.parse(json) as EvaluationBatch).records.length).toBeLessThanOrEqual(MAX_RECORDS_PER_BATCH);
      // What the reporter sends, the intake accepts whole.
      expect(parseEvaluationBatch(json, MAX_BATCH_BYTES)).toBeDefined();
    }
    const delivered = sent.flatMap((json) => (JSON.parse(json) as EvaluationBatch).records);
    expect(delivered.map((entry) => entry.flagKey.split('-')[0])).toEqual(
      Array.from({ length: 90 }, (_, index) => String(index))
    );
  });

  it('counts the errors in the first envelope against the bound', () => {
    const { reporter, sent } = createReporter();
    for (let index = 0; index < 5; index += 1) reporter.reportError(new Error('€'.repeat(1024)));
    for (let index = 0; index < 99; index += 1) reporter.add(record({ flagKey: '🚩'.repeat(128) }));
    reporter.flush();
    for (const json of sent) expect(utf8(json)).toBeLessThanOrEqual(MAX_BATCH_BYTES);
    expect(sent.flatMap((json) => (JSON.parse(json) as EvaluationBatch).records)).toHaveLength(99);
  });

  it('drops a record that alone exceeds the bound and reports it in droppedCount', () => {
    const { reporter, sent } = createReporter();
    reporter.add(record({ flagKey: 'small-before' }));
    reporter.add(record({ flagKey: 'huge', allocationKey: '€'.repeat(30_000) })); // 90 KB of UTF-8
    reporter.add(record({ flagKey: 'small-after' }));
    reporter.flush();
    const batches = sent.map((json) => JSON.parse(json) as EvaluationBatch);
    expect(batches.flatMap((batch) => batch.records.map((entry) => entry.flagKey))).toEqual([
      'small-before',
      'small-after',
    ]);
    expect(batches.reduce((count, batch) => count + (batch.droppedCount ?? 0), 0)).toBe(1);
    expect(parseEvaluationBatch(sent[0], MAX_BATCH_BYTES)?.droppedCount).toBe(1);
  });
});
