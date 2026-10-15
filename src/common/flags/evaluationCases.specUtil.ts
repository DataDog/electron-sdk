import {
  DatadogCoreProvider,
  configurationFromString,
  configurationToString,
} from '@datadog/openfeature-browser/rules-based';
import type { EvaluationDetails, FlagValue, FlagValueType, Logger, ResolutionDetails } from '@openfeature/web-sdk';
import type { FlagsSnapshot, FlatContext } from './types';

/**
 * Hand-authored UFC rules configuration used by the evaluator parity tests (M1), the
 * main provider tests (M3) and the renderer provider tests (M4).
 *
 * The protobuf-ES runtime identifies messages by their `$typeName` property, so plain
 * objects stamped with the type name are valid message inputs (see the M0 S1 spike
 * findings). The fixture is serialized with `configurationToString` to exercise the
 * same path renderers use.
 */
const PROTO = 'datadog.ffe.flagging.ufc.v1.';
const type = (name: string, value: Record<string, unknown>) => ({ $typeName: PROTO + name, ...value }) as never;

const STRINGS = ['pro', 'free', 'plan', 'on', 'off', 'variant-a', 'str-default', 'a', 'b', 'k-1', 'json-default'];
const stringIndex = (value: string) => STRINGS.indexOf(value);

const handAuthoredResponse = type('FlagsConfiguration', {
  environmentName: 'electron-sdk-e2e',
  flags: {
    'targeted-flag': type('Flag', {
      minimumFeatureLevel: 0,
      variationType: 1, // STRING
      variations: [
        type('Variation', {
          keyStringIndex: stringIndex('variant-a'),
          value: { case: 'stringValueIndex', value: stringIndex('variant-a') },
        }),
        type('Variation', {
          keyStringIndex: stringIndex('str-default'),
          value: { case: 'stringValueIndex', value: stringIndex('str-default') },
        }),
      ],
      allocations: [
        type('Allocation', {
          key: 'targeted-pro',
          partitionKey: [],
          targetingConditionIndex: 0,
          splits: [type('Split', { ranges: [], variationIndex: 0, serialId: 1, reason: 3 /* STATIC */ })],
          logExposureEvent: true,
        }),
        type('Allocation', {
          key: 'targeted-fallback',
          partitionKey: [],
          splits: [type('Split', { ranges: [], variationIndex: 1, reason: 3 /* STATIC */ })],
          logExposureEvent: true,
        }),
      ],
    }),
    'split-flag': type('Flag', {
      minimumFeatureLevel: 0,
      variationType: 4, // BOOLEAN
      variations: [
        type('Variation', { keyStringIndex: stringIndex('on'), value: { case: 'booleanValue', value: true } }),
        type('Variation', { keyStringIndex: stringIndex('off'), value: { case: 'booleanValue', value: false } }),
      ],
      allocations: [
        type('Allocation', {
          key: 'split-allocation',
          partitionKey: [
            type('PartitionKey', {
              kind: {
                case: 'shardMd5',
                value: type('Md5ShardPartitionKey', { salt: 'parity-salt', attributeIndex: 1, totalShards: 100n }),
              },
            }),
          ],
          splits: [
            type('Split', {
              ranges: [type('PartitionRange', { from: 0n, to: 50n })],
              variationIndex: 0,
              serialId: 2,
              reason: 2 /* SPLIT */,
            }),
            type('Split', {
              ranges: [type('PartitionRange', { from: 50n, to: 100n })],
              variationIndex: 1,
              serialId: 2,
              reason: 2 /* SPLIT */,
            }),
          ],
          logExposureEvent: true,
        }),
      ],
    }),
    'disabled-flag': type('Flag', {
      minimumFeatureLevel: 0,
      variationType: 4, // BOOLEAN
      variations: [
        type('Variation', { keyStringIndex: stringIndex('on'), value: { case: 'booleanValue', value: true } }),
      ],
      allocations: [],
    }),
    'unlogged-flag': type('Flag', {
      minimumFeatureLevel: 0,
      variationType: 1, // STRING
      variations: [
        type('Variation', {
          keyStringIndex: stringIndex('a'),
          value: { case: 'stringValueIndex', value: stringIndex('a') },
        }),
      ],
      allocations: [
        type('Allocation', {
          key: 'unlogged-allocation',
          partitionKey: [],
          splits: [type('Split', { ranges: [], variationIndex: 0, reason: 3 /* STATIC */ })],
          logExposureEvent: false,
        }),
      ],
    }),
    'object-flag': type('Flag', {
      minimumFeatureLevel: 0,
      variationType: 5, // JSON
      variations: [
        type('Variation', { keyStringIndex: stringIndex('k-1'), value: { case: 'jsonStringIndex', value: 0 } }),
        type('Variation', {
          keyStringIndex: stringIndex('json-default'),
          value: { case: 'jsonStringIndex', value: 1 },
        }),
      ],
      allocations: [
        type('Allocation', {
          key: 'object-allocation',
          partitionKey: [],
          splits: [type('Split', { ranges: [], variationIndex: 0, reason: 3 /* STATIC */ })],
          logExposureEvent: true,
        }),
      ],
    }),
  },
  attributes: [
    type('AttributeReference', {
      kind: {
        case: 'attributePath',
        value: type('AttributePath', {
          segments: [
            type('AttributePathSegment', { kind: { case: 'objectKeyStringIndex', value: stringIndex('plan') } }),
          ],
        }),
      },
    }),
    type('AttributeReference', { kind: { case: 'targetingKey', value: {} } }),
  ],
  strings: STRINGS,
  regexes: [],
  versions: [],
  jsonStrings: ['{"k":1}', '"json-default"'],
  conditions: [
    type('Condition', {
      kind: {
        case: 'stringMembership',
        value: type('StringMembershipCondition', {
          attributeIndex: 0,
          stringIndexes: [stringIndex('pro')],
          negate: false,
        }),
      },
    }),
  ],
});

/**
 * Canonical fixture response.
 *
 * The hand-authored object above does not survive a serialize/decode round trip
 * byte-for-byte (protobuf-ES normalizes absent optional fields on the first decode,
 * after which the wire is a fixpoint — see the M0 S1 findings). Canonicalizing through
 * one decode makes the oracle (direct object) and the evaluator (serialized wire) hash
 * to the same `__dd_core_configuration_id`, matching how main and renderers both
 * evaluate the same published wire.
 */
const rawWire = configurationToString({ rules: { response: handAuthoredResponse } });
export const fixtureResponse = configurationFromString(rawWire).rules!.response;
export const fixtureConfiguration = { rules: { response: fixtureResponse } };
export const fixtureWire = configurationToString(fixtureConfiguration);

export const proContext: FlatContext = { targetingKey: 'user-pro', plan: 'pro' };
export const freeContext: FlatContext = { targetingKey: 'user-free', plan: 'free' };
export const anonymousContext: FlatContext = { targetingKey: 'anonymous-1' };

export interface EvaluationCase {
  name: string;
  type: FlagValueType;
  flagKey: string;
  defaultValue: FlagValue;
  context: FlatContext;
}

export const CASES: EvaluationCase[] = [
  {
    name: 'targeted flag matches for pro',
    type: 'string',
    flagKey: 'targeted-flag',
    defaultValue: 'app-default',
    context: proContext,
  },
  {
    name: 'targeted flag falls back for free',
    type: 'string',
    flagKey: 'targeted-flag',
    defaultValue: 'app-default',
    context: freeContext,
  },
  {
    name: 'split flag buckets key 1 off',
    type: 'boolean',
    flagKey: 'split-flag',
    defaultValue: true,
    context: { targetingKey: 'split-key-1' },
  },
  {
    name: 'split flag buckets key 5 on',
    type: 'boolean',
    flagKey: 'split-flag',
    defaultValue: true,
    context: { targetingKey: 'split-key-5' },
  },
  {
    name: 'disabled flag returns the default',
    type: 'boolean',
    flagKey: 'disabled-flag',
    defaultValue: true,
    context: proContext,
  },
  {
    name: 'unlogged flag resolves without exposure',
    type: 'string',
    flagKey: 'unlogged-flag',
    defaultValue: 'app-default',
    context: proContext,
  },
  {
    name: 'object flag resolves json',
    type: 'object',
    flagKey: 'object-flag',
    defaultValue: { no: true },
    context: proContext,
  },
  {
    name: 'type mismatch on a boolean flag',
    type: 'string',
    flagKey: 'split-flag',
    defaultValue: 'app-default',
    context: proContext,
  },
];

export const noopLogger: Logger = {
  error: () => undefined,
  warn: () => undefined,
  debug: () => undefined,
  info: () => undefined,
};

function resolveOnProvider(
  provider: DatadogCoreProvider,
  evaluationCase: EvaluationCase
): ResolutionDetails<FlagValue> {
  switch (evaluationCase.type) {
    case 'boolean':
      return provider.resolveBooleanEvaluation(
        evaluationCase.flagKey,
        evaluationCase.defaultValue as boolean,
        evaluationCase.context,
        noopLogger
      );
    case 'string':
      return provider.resolveStringEvaluation(
        evaluationCase.flagKey,
        evaluationCase.defaultValue as string,
        evaluationCase.context,
        noopLogger
      );
    case 'number':
      return provider.resolveNumberEvaluation(
        evaluationCase.flagKey,
        evaluationCase.defaultValue as number,
        evaluationCase.context,
        noopLogger
      );
    case 'object':
      return provider.resolveObjectEvaluation(
        evaluationCase.flagKey,
        evaluationCase.defaultValue as never,
        evaluationCase.context,
        noopLogger
      );
  }
}

/**
 * Evaluate a case with a raw upstream `DatadogCoreProvider` over the fixture object
 * directly. The provider is the oracle: no expected flag values are hand-written.
 */
export function oracle(evaluationCase: EvaluationCase): EvaluationDetails<FlagValue> {
  const provider = new DatadogCoreProvider();
  provider.setConfiguration(fixtureConfiguration);
  const result = resolveOnProvider(provider, evaluationCase);
  return { flagKey: evaluationCase.flagKey, flagMetadata: {}, ...result };
}

export function fixtureSnapshot(overrides: Partial<FlagsSnapshot> = {}): FlagsSnapshot {
  return {
    revision: 1,
    status: 'READY',
    configuration: fixtureWire,
    context: proContext,
    contextRevision: 1,
    configurationRevision: 1,
    tracking: { exposures: true, rum: true, evaluations: true },
    ...overrides,
  };
}

export { resolveOnProvider };
