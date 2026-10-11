import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { configurationToString } from '@datadog/openfeature-browser/rules-based';
import { FlagsEvaluator } from './FlagsEvaluator';
import {
  CASES,
  oracle,
  fixtureSnapshot,
  fixtureConfiguration,
  proContext,
  freeContext,
} from './evaluationCases.specUtil';
import {
  PRECOMPUTED_CASES,
  precomputedOracle,
  precomputedSnapshot,
  precomputedWire,
  precomputedWireV2,
  otherPrecomputedContext,
} from './precomputedCases.specUtil';

// A second wire where the pro allocation serves the fallback variation, so a stale
// configuration is detectable by value.
function fixtureWireV2(): string {
  const clone = structuredClone(fixtureConfiguration) as {
    rules: {
      response: { flags: Record<string, { allocations: { key: string; splits: { variationIndex: number }[] }[] }> };
    };
  };
  const targeted = clone.rules.response.flags['targeted-flag'];
  targeted.allocations[0].splits[0].variationIndex = 1;
  return configurationToString(clone as never);
}

describe('FlagsEvaluator', () => {
  beforeEach(() => {
    // Freeze time so flagMetadata evaluation timestamps match between oracle and evaluator.
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  for (const evaluationCase of CASES) {
    it(`parity › ${evaluationCase.name}`, () => {
      const evaluator = new FlagsEvaluator();
      expect(evaluator.apply(fixtureSnapshot({ context: evaluationCase.context }))).toBe(true);
      const result = evaluator.resolve(evaluationCase.type, evaluationCase.flagKey, evaluationCase.defaultValue);
      const expected = oracle(evaluationCase);
      expect({
        value: result.value,
        variant: result.variant,
        reason: result.reason,
        errorCode: result.errorCode,
        flagMetadata: result.flagMetadata,
      }).toEqual({
        value: expected.value,
        variant: expected.variant,
        reason: expected.reason,
        errorCode: expected.errorCode,
        flagMetadata: expected.flagMetadata,
      });
    });
  }

  it('returns the application default with PROVIDER_NOT_READY before any snapshot', () => {
    const evaluator = new FlagsEvaluator();
    const result = evaluator.resolve('string', 'targeted-flag', 'app-default');
    expect(result.value).toBe('app-default');
    expect(result.errorCode).toBe('PROVIDER_NOT_READY');
  });

  it('ignores a snapshot whose revision is not newer', () => {
    const evaluator = new FlagsEvaluator();
    expect(evaluator.apply(fixtureSnapshot({ revision: 5 }))).toBe(true);
    expect(evaluator.apply(fixtureSnapshot({ revision: 5 }))).toBe(false);
    expect(evaluator.apply(fixtureSnapshot({ revision: 4 }))).toBe(false);
    // The older snapshot did not clobber the configuration.
    const result = evaluator.resolve('string', 'targeted-flag', 'app-default');
    expect(result.value).toBe('variant-a');
  });

  it('never mixes configuration and context from different snapshots', () => {
    const evaluator = new FlagsEvaluator();
    // rev 1: first configuration, pro context → variant-a via the pro allocation.
    evaluator.apply(fixtureSnapshot({ revision: 1, context: proContext }));
    expect(evaluator.resolve('string', 'targeted-flag', 'app-default').flagMetadata.allocationKey).toBe('targeted-pro');

    // rev 2: second configuration (pro allocation serves the fallback variation), same context.
    evaluator.apply(fixtureSnapshot({ revision: 2, configuration: fixtureWireV2(), context: proContext }));
    const afterConfigChange = evaluator.resolve('string', 'targeted-flag', 'app-default');
    expect(afterConfigChange.value).toBe('str-default');
    expect(afterConfigChange.flagMetadata.allocationKey).toBe('targeted-pro');

    // rev 3: new context, no configuration change — the second configuration is retained.
    evaluator.apply(fixtureSnapshot({ revision: 3, configuration: fixtureWireV2(), context: freeContext }));
    const afterContextChange = evaluator.resolve('string', 'targeted-flag', 'app-default');
    expect(afterContextChange.value).toBe('str-default');
    expect(afterContextChange.flagMetadata.allocationKey).toBe('targeted-fallback');
  });

  it('returns the default with TYPE_MISMATCH for a wrong-typed flag', () => {
    const evaluator = new FlagsEvaluator();
    evaluator.apply(fixtureSnapshot());
    const result = evaluator.resolve('string', 'split-flag', 'app-default');
    expect(result.value).toBe('app-default');
    expect(result.errorCode).toBe('TYPE_MISMATCH');
  });

  it('stop() releases the provider', () => {
    const evaluator = new FlagsEvaluator();
    evaluator.apply(fixtureSnapshot());
    evaluator.stop();
    const result = evaluator.resolve('string', 'targeted-flag', 'app-default');
    expect(result.value).toBe('app-default');
    expect(result.errorCode).toBe('PROVIDER_NOT_READY');
    // A snapshot can be applied again after stop.
    expect(evaluator.apply(fixtureSnapshot({ revision: 2 }))).toBe(true);
    expect(evaluator.resolve('string', 'targeted-flag', 'app-default').value).toBe('variant-a');
  });

  it('clears the configuration when a snapshot reports ERROR without one', () => {
    const evaluator = new FlagsEvaluator();
    evaluator.apply(fixtureSnapshot());
    expect(
      evaluator.apply(fixtureSnapshot({ revision: 2, status: 'ERROR', configuration: undefined, context: undefined }))
    ).toBe(true);
    const result = evaluator.resolve('string', 'targeted-flag', 'app-default');
    expect(result.value).toBe('app-default');
    expect(result.errorCode).toBe('PROVIDER_NOT_READY');
  });

  it('applies snapshots whose configuration is absent without disturbing the current one', () => {
    const evaluator = new FlagsEvaluator();
    evaluator.apply(fixtureSnapshot({ revision: 1 }));
    expect(evaluator.apply(fixtureSnapshot({ revision: 2, configuration: undefined, context: freeContext }))).toBe(
      true
    );
    expect(evaluator.resolve('string', 'targeted-flag', 'app-default').flagMetadata.allocationKey).toBe(
      'targeted-fallback'
    );
  });

  describe('precomputed', () => {
    for (const evaluationCase of PRECOMPUTED_CASES) {
      it(`precomputed parity › ${evaluationCase.name}`, () => {
        const evaluator = new FlagsEvaluator();
        expect(evaluator.apply(precomputedSnapshot({ context: evaluationCase.context }))).toBe(true);
        const result = evaluator.resolve(evaluationCase.type, evaluationCase.flagKey, evaluationCase.defaultValue);
        const expected = precomputedOracle(evaluationCase);
        expect({
          value: result.value,
          variant: result.variant,
          reason: result.reason,
          errorCode: result.errorCode,
          flagMetadata: result.flagMetadata,
        }).toEqual({
          value: expected.value,
          variant: expected.variant,
          reason: expected.reason,
          errorCode: expected.errorCode,
          flagMetadata: expected.flagMetadata,
        });
      });
    }

    it('a precomputed snapshot evaluates against its own context only', () => {
      const evaluator = new FlagsEvaluator();
      evaluator.apply(precomputedSnapshot({ context: otherPrecomputedContext }));
      const result = evaluator.resolve('string', 'assigned-flag', 'app-default');
      expect(result.value).toBe('app-default');
      expect(result.errorCode).toBe('INVALID_CONTEXT');
    });

    it('reports TYPE_MISMATCH and FLAG_NOT_FOUND on precomputed flags', () => {
      const evaluator = new FlagsEvaluator();
      evaluator.apply(precomputedSnapshot());
      const mismatch = evaluator.resolve('string', 'bool-flag', 'app-default');
      expect(mismatch.value).toBe('app-default');
      expect(mismatch.errorCode).toBe('TYPE_MISMATCH');
      const missing = evaluator.resolve('string', 'missing-flag', 'app-default');
      expect(missing.value).toBe('app-default');
      expect(missing.errorCode).toBe('FLAG_NOT_FOUND');
    });

    it('switching capability between snapshots never mixes evaluators', () => {
      const evaluator = new FlagsEvaluator();
      // rules first
      evaluator.apply(fixtureSnapshot({ revision: 1 }));
      expect(evaluator.resolve('string', 'targeted-flag', 'app-default').value).toBe('variant-a');
      // then precomputed
      evaluator.apply(precomputedSnapshot({ revision: 2 }));
      expect(evaluator.resolve('string', 'assigned-flag', 'app-default').value).toBe('variant-a');
      const staleRules = evaluator.resolve('string', 'targeted-flag', 'app-default');
      expect(staleRules.value).toBe('app-default');
      expect(staleRules.errorCode).toBe('FLAG_NOT_FOUND');
      // and back to rules
      evaluator.apply(fixtureSnapshot({ revision: 3 }));
      expect(evaluator.resolve('string', 'targeted-flag', 'app-default').value).toBe('variant-a');
      const stalePrecomputed = evaluator.resolve('string', 'assigned-flag', 'app-default');
      expect(stalePrecomputed.value).toBe('app-default');
      expect(stalePrecomputed.errorCode).toBe('FLAG_NOT_FOUND');
    });

    it('a newer precomputed wire replaces the previous one', () => {
      const evaluator = new FlagsEvaluator();
      evaluator.apply(precomputedSnapshot({ revision: 1 }));
      expect(evaluator.resolve('string', 'assigned-flag', 'app-default').variant).toBe('variant-a');
      evaluator.apply(precomputedSnapshot({ revision: 2, configuration: precomputedWireV2() }));
      const replaced = evaluator.resolve('string', 'assigned-flag', 'app-default');
      expect(replaced.value).toBe('variant-a2');
      expect(replaced.flagMetadata.allocationKey).toBe('assign-a2');
    });

    it('serves defaults while a changed-targeting-key context fetch is in flight (NOT_READY without a configuration)', () => {
      const evaluator = new FlagsEvaluator();
      evaluator.apply(precomputedSnapshot({ revision: 1 }));
      expect(
        evaluator.apply(
          precomputedSnapshot({
            revision: 2,
            status: 'NOT_READY',
            configuration: undefined,
            context: otherPrecomputedContext,
            contextRevision: 2,
          })
        )
      ).toBe(true);
      const result = evaluator.resolve('string', 'assigned-flag', 'app-default');
      expect(result.value).toBe('app-default');
      expect(result.errorCode).toBe('PROVIDER_NOT_READY');
      // The new assignments then apply atomically with their context.
      evaluator.apply(
        precomputedSnapshot({ revision: 3, context: otherPrecomputedContext, contextRevision: 2, configurationRevision: 2 })
      );
      expect(evaluator.contextRevision).toBe(2);
    });

    it('keeps the same wire string for a precomputed configuration (payloads treat it as opaque)', () => {
      // The rules wire function serializes the precomputed capability unchanged; the
      // payload validator accepts any configuration string (opaque, M7 step 3).
      expect(typeof precomputedWire).toBe('string');
      expect(precomputedWire.length).toBeGreaterThan(0);
    });
  });
});
