import { configurationToString } from '@datadog/openfeature-browser/rules-based';
import { evaluatePrecomputedConfiguration } from '@datadog/flagging-core';
import type { FlagsConfiguration } from '@datadog/flagging-core';
import type { EvaluationDetails, FlagValue, FlagValueType, ResolutionDetails } from '@openfeature/web-sdk';
import type { FlagsSnapshot, FlatContext } from './types';

/**
 * Hand-authored precomputed assignments response used by the evaluator, main provider,
 * renderer provider and child client parity tests (M7).
 *
 * The response is the JSON:API payload `/precompute-assignments` returns (plaintext
 * variant), serialized with the same `configurationToString` wire function every
 * process uses, so parity covers the serialization path (P2).
 */
export const PRECOMPUTED_CREATED_AT = '2026-03-04T10:00:00.000Z';

export const precomputedContext: FlatContext = { targetingKey: 'user-pro', plan: 'pro' };
export const otherPrecomputedContext: FlatContext = { targetingKey: 'user-free', plan: 'free' };

export const precomputedResponse = {
  data: {
    attributes: {
      createdAt: PRECOMPUTED_CREATED_AT,
      flags: {
        'assigned-flag': {
          allocationKey: 'assign-a',
          variationKey: 'variant-a',
          variationType: 'string',
          variationValue: 'variant-a',
          reason: 'STATIC',
          doLog: true,
          serialId: 11,
        },
        'bool-flag': {
          allocationKey: 'assign-bool',
          variationKey: 'on',
          variationType: 'boolean',
          variationValue: true,
          reason: 'SPLIT',
          doLog: true,
          serialId: 12,
        },
        'unlogged-flag': {
          allocationKey: 'assign-unlogged',
          variationKey: 'a',
          variationType: 'string',
          variationValue: 'a',
          reason: 'STATIC',
          doLog: false,
        },
        'object-flag': {
          allocationKey: 'assign-object',
          variationKey: 'k-1',
          variationType: 'object',
          variationValue: { k: 1 },
          reason: 'STATIC',
          doLog: true,
          serialId: 13,
        },
      },
    },
  },
} as never;

export const precomputedConfiguration = {
  precomputed: {
    response: precomputedResponse,
    context: precomputedContext,
    fetchedAt: 1_772_000_000_000,
  },
} as unknown as FlagsConfiguration;

export const precomputedWire = configurationToString(precomputedConfiguration);

/** A second wire with a different `createdAt`, so a new configuration identity is detectable. */
export function precomputedWireV2(): string {
  return configurationToString({
    precomputed: {
      response: {
        data: {
          attributes: {
            createdAt: '2026-03-05T10:00:00.000Z',
            flags: {
              ...(precomputedResponse as { data: { attributes: { flags: Record<string, unknown> } } }).data.attributes
                .flags,
              'assigned-flag': {
                allocationKey: 'assign-a2',
                variationKey: 'variant-a2',
                variationType: 'string',
                variationValue: 'variant-a2',
                reason: 'STATIC',
                doLog: true,
                serialId: 11,
              },
            },
          },
        },
      },
      context: precomputedContext,
      fetchedAt: 1_772_100_000_000,
    },
  } as never);
}

export interface PrecomputedEvaluationCase {
  name: string;
  type: FlagValueType;
  flagKey: string;
  defaultValue: FlagValue;
  context: FlatContext;
}

export const PRECOMPUTED_CASES: PrecomputedEvaluationCase[] = [
  {
    name: 'assigned flag resolves its variant',
    type: 'string',
    flagKey: 'assigned-flag',
    defaultValue: 'app-default',
    context: precomputedContext,
  },
  {
    name: 'missing flag returns the default',
    type: 'string',
    flagKey: 'missing-flag',
    defaultValue: 'app-default',
    context: precomputedContext,
  },
  {
    name: 'unlogged flag resolves without exposure',
    type: 'string',
    flagKey: 'unlogged-flag',
    defaultValue: 'app-default',
    context: precomputedContext,
  },
  {
    name: 'boolean flag resolves true',
    type: 'boolean',
    flagKey: 'bool-flag',
    defaultValue: false,
    context: precomputedContext,
  },
  {
    name: 'object flag resolves json',
    type: 'object',
    flagKey: 'object-flag',
    defaultValue: { no: true },
    context: precomputedContext,
  },
  {
    name: 'type mismatch on the boolean flag',
    type: 'string',
    flagKey: 'bool-flag',
    defaultValue: 'app-default',
    context: precomputedContext,
  },
];

/**
 * Evaluate a case with the raw upstream `evaluatePrecomputedConfiguration` over the
 * hand-authored object directly — the exact function the upstream `DatadogProvider`
 * calls on resolve (P2), so no expected flag values are hand-written.
 */
export function precomputedOracle(evaluationCase: PrecomputedEvaluationCase): EvaluationDetails<FlagValue> {
  const result = evaluatePrecomputedConfiguration(
    precomputedConfiguration,
    evaluationCase.type,
    evaluationCase.flagKey,
    evaluationCase.defaultValue,
    evaluationCase.context
  ) as ResolutionDetails<FlagValue>;
  return { flagKey: evaluationCase.flagKey, flagMetadata: {}, ...result };
}

export function precomputedSnapshot(overrides: Partial<FlagsSnapshot> = {}): FlagsSnapshot {
  return {
    revision: 1,
    status: 'READY',
    configuration: precomputedWire,
    context: precomputedContext,
    contextRevision: 1,
    configurationRevision: 1,
    tracking: { exposures: true, rum: true, evaluations: true },
    ...overrides,
  };
}
