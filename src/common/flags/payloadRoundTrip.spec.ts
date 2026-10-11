import { describe, it, expect } from 'vitest';
import type { TimeStamp } from '@datadog/js-core/time';
import { FlagsState } from '../../domain/flags/FlagsState';
import { EvaluationReporter, MAX_BATCH_BYTES } from './EvaluationReporter';
import { parseEvaluationBatch, parseFlagsSnapshot } from './flagsPayloads';
import type { EvaluationBatch, EvaluationRecord, FlagsSnapshot } from './types';

/**
 * Producer → parser round trips over every payload field. The fixtures are typed with
 * `Required<…>`, so adding a field to a payload type fails compilation here until the
 * fixture (and therefore the parser) covers it.
 */
describe('feature flags payload round trips', () => {
  it('a FlagsState snapshot survives serialization and parseFlagsSnapshot with every field', () => {
    const state = new FlagsState({ targetingKey: 'user-1', plan: 'pro', seats: 3, beta: true });
    state.applyConfigurationUpdate({ configuration: 'wire-config', status: 'STALE', errorMessage: 'rules stale' });
    state.setTracking({ exposures: false, rum: true, evaluations: false });
    const expected: Required<FlagsSnapshot> = {
      revision: 2,
      status: 'STALE',
      configuration: 'wire-config',
      context: { targetingKey: 'user-1', plan: 'pro', seats: 3, beta: true },
      contextRevision: 0,
      configurationRevision: 1,
      tracking: { exposures: false, rum: true, evaluations: false },
      errorMessage: 'rules stale',
    };
    expect(state.snapshot()).toEqual(expected);
    expect(parseFlagsSnapshot(JSON.stringify(state.snapshot()))).toEqual(expected);
  });

  it('an EvaluationReporter batch survives parseEvaluationBatch with every record, error and count field', () => {
    const sent: string[] = [];
    const reporter = new EvaluationReporter({
      send: (json) => sent.push(json),
      setTimeout: () => 1,
      clearTimeout: () => undefined,
    });
    reporter.setTracking({ exposures: true, rum: true, evaluations: true });
    const record: Required<EvaluationRecord> = {
      flagKey: 'flag',
      variant: 'on',
      allocationKey: 'alloc-1',
      reason: 'TARGETING_MATCH',
      errorCode: 'GENERAL',
      doLog: true,
      serialId: 7,
      configurationId: 'config-1',
      contextRevision: 4,
      timestamp: 1234 as TimeStamp,
      viewId: 'view-1',
      viewUrl: 'app://window/settings',
    };
    reporter.add(record);
    const error = new Error('provider failure');
    reporter.reportError(error);
    reporter.add({ ...record, flagKey: 'huge', allocationKey: 'a'.repeat(MAX_BATCH_BYTES) }); // dropped and counted
    reporter.flush();
    expect(sent).toHaveLength(1);
    const expected: Required<EvaluationBatch> = {
      records: [record],
      errors: [{ message: 'provider failure', stack: error.stack!.slice(0, 1024) }],
      droppedCount: 1,
    };
    expect(JSON.parse(sent[0])).toEqual(expected);
    const parsed = parseEvaluationBatch(sent[0], MAX_BATCH_BYTES);
    expect(parsed).toEqual({ batch: { records: expected.records, errors: expected.errors }, droppedCount: 1 });
  });
});
