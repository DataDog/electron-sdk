import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OperationCollection, type FeatureOperationOptions } from './OperationCollection';
import { EventFormat, EventKind, EventManager, type RawRumEvent } from '../../../event';
import type { RawRumVital } from '../rawRumData.types';
import { displayError, displayWarn } from '../../../tools/display';

vi.mock('../../../tools/display', () => ({
  displayError: vi.fn(),
  displayWarn: vi.fn(),
  displayInfo: vi.fn(),
}));

// Strict RFC 4122 v4 — matches the schema pattern and browser-core's generateUUID output.
const UUID_REGEX = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

describe('OperationCollection', () => {
  let eventManager: EventManager;
  let operationCollection: OperationCollection;
  let rawRumEvents: RawRumEvent[];

  beforeEach(() => {
    vi.clearAllMocks();
    eventManager = new EventManager();
    rawRumEvents = [];
    eventManager.registerHandler<RawRumEvent>({
      canHandle: (event): event is RawRumEvent => event.kind === EventKind.RAW && event.format === EventFormat.RUM,
      handle: (event) => rawRumEvents.push(event),
    });
    operationCollection = new OperationCollection(eventManager);
  });

  // --- API-01..API-06 ---
  describe('public API dispatch', () => {
    it('API-01 / PAY-01 / PAY-07 / PAY-08 / PAY-09: startOperation emits a start vital event with full payload shape', () => {
      operationCollection.getApi().startOperation('login');

      expect(rawRumEvents).toHaveLength(1);
      const data = rawRumEvents[0].data as RawRumVital;
      expect(data.type).toBe('vital');
      expect(data.vital.type).toBe('operation_step');
      expect(data.vital.step_type).toBe('start');
      expect(data.vital.name).toBe('login');
      expect(data.vital.failure_reason).toBeUndefined();
      expect('operation_key' in data.vital).toBe(false);
      expect(data.vital.id).toMatch(UUID_REGEX);
    });

    it('API-02 / PAY-02: succeedOperation emits an end vital event without failure_reason', () => {
      operationCollection.getApi().succeedOperation('login');

      expect(rawRumEvents).toHaveLength(1);
      const data = rawRumEvents[0].data as RawRumVital;
      expect(data.vital.step_type).toBe('end');
      expect(data.vital.failure_reason).toBeUndefined();
    });

    it('API-03 / PAY-03: failOperation emits an end vital event with failure_reason', () => {
      operationCollection.getApi().failOperation('login', 'error');

      expect(rawRumEvents).toHaveLength(1);
      const data = rawRumEvents[0].data as RawRumVital;
      expect(data.vital.step_type).toBe('end');
      expect(data.vital.failure_reason).toBe('error');
    });

    it('API-04 / PAY-10: operationKey is forwarded to the event payload', () => {
      operationCollection.getApi().startOperation('login', { operationKey: 'abc' });

      const data = rawRumEvents[0].data as RawRumVital;
      expect(data.vital.operation_key).toBe('abc');
    });

    it('API-05: options.context is forwarded to the event context', () => {
      operationCollection.getApi().startOperation('login', { context: { key: 'value' } });

      const data = rawRumEvents[0].data as RawRumVital;
      expect(data.context).toEqual({ key: 'value' });
    });

    it('API-06: each call produces a unique vital.id', () => {
      operationCollection.getApi().startOperation('login');
      operationCollection.getApi().startOperation('login');

      expect(rawRumEvents).toHaveLength(2);
      const firstId = (rawRumEvents[0].data as RawRumVital).vital.id;
      const secondId = (rawRumEvents[1].data as RawRumVital).vital.id;
      expect(firstId).not.toBe(secondId);
    });

    it('forwards description into the vital section when provided', () => {
      operationCollection.getApi().startOperation('login', { description: 'user tapped login' });

      const data = rawRumEvents[0].data as RawRumVital;
      expect(data.vital.description).toBe('user tapped login');
    });
  });

  // --- VAL-01..VAL-07 ---
  describe('input validation', () => {
    it('VAL-01: empty name is rejected and no event is emitted', () => {
      // The backend rejects blank/empty names with its own non-empty precondition before evaluating the character-set
      // regex; drop client-side to match.
      operationCollection.getApi().startOperation('');

      expect(rawRumEvents).toHaveLength(0);
      expect(displayError).toHaveBeenCalledOnce();
      expect(vi.mocked(displayError).mock.calls[0][0]).toContain('operation name cannot be empty');
    });

    it('VAL-02: whitespace-only name is rejected and no event is emitted', () => {
      operationCollection.getApi().startOperation('   ');

      expect(rawRumEvents).toHaveLength(0);
      expect(displayError).toHaveBeenCalledOnce();
      expect(vi.mocked(displayError).mock.calls[0][0]).toContain('operation name cannot be empty');
    });

    it('VAL-03: empty operationKey is rejected as blank', () => {
      operationCollection.getApi().startOperation('login', { operationKey: '' });

      expect(rawRumEvents).toHaveLength(0);
      expect(displayError).toHaveBeenCalledOnce();
      expect(vi.mocked(displayError).mock.calls[0][0]).toContain('operation key cannot be empty');
    });

    it('VAL-04: whitespace-only operationKey is rejected', () => {
      operationCollection.getApi().startOperation('login', { operationKey: '   ' });

      expect(rawRumEvents).toHaveLength(0);
      expect(displayError).toHaveBeenCalledOnce();
    });

    it('VAL-05: undefined operationKey is valid and results in an unkeyed operation', () => {
      operationCollection.getApi().startOperation('login', { operationKey: undefined });

      expect(rawRumEvents).toHaveLength(1);
      const data = rawRumEvents[0].data as RawRumVital;
      expect(data.vital.operation_key).toBeUndefined();
      expect(displayError).not.toHaveBeenCalled();
    });

    it('VAL-07: blank name on succeedOperation is rejected', () => {
      operationCollection.getApi().succeedOperation('');
      expect(rawRumEvents).toHaveLength(0);
      expect(displayError).toHaveBeenCalledOnce();
    });

    it('VAL-07: blank name on failOperation is rejected', () => {
      operationCollection.getApi().failOperation('', 'error');
      expect(rawRumEvents).toHaveLength(0);
      expect(displayError).toHaveBeenCalledOnce();
    });

    it('VAL-07: blank operationKey is rejected on succeedOperation', () => {
      operationCollection.getApi().succeedOperation('login', { operationKey: '' });
      expect(rawRumEvents).toHaveLength(0);
      expect(displayError).toHaveBeenCalledOnce();
      expect(vi.mocked(displayError).mock.calls[0][0]).toContain('operation key cannot be empty');
    });

    it('VAL-07: blank operationKey is rejected on failOperation', () => {
      operationCollection.getApi().failOperation('login', 'error', { operationKey: '   ' });
      expect(rawRumEvents).toHaveLength(0);
      expect(displayError).toHaveBeenCalledOnce();
      expect(vi.mocked(displayError).mock.calls[0][0]).toContain('operation key cannot be empty');
    });

    // The public API is typed as `(name: string, options?: FeatureOperationOptions)`, but the validator accepts
    // `unknown` to defend against JS callers passing garbage. These tests pin the runtime contract independent of the
    // type system.
    it.each([
      ['null', null],
      ['number', 42],
      ['string', 'oops'],
      ['boolean', true],
      ['array', ['operationKey']],
    ])('rejects non-object %s as options and emits no event', (_label, badOptions) => {
      operationCollection.getApi().startOperation('login', badOptions as unknown as FeatureOperationOptions);
      expect(rawRumEvents).toHaveLength(0);
      expect(displayError).toHaveBeenCalledOnce();
      expect(vi.mocked(displayError).mock.calls[0][0]).toContain('options must be an object');
    });

    it.each([
      ['null', null],
      ['number', 42],
    ])('rejects non-string %s as name and emits no event', (_label, badName) => {
      operationCollection.getApi().startOperation(badName as unknown as string);
      expect(rawRumEvents).toHaveLength(0);
      expect(displayError).toHaveBeenCalledOnce();
      expect(vi.mocked(displayError).mock.calls[0][0]).toContain('operation name cannot be empty');
    });
  });

  // --- Name character-set validation (schema facet-path rule) ---
  // The authoritative _vital-common-schema.json says vital.name "must contain only letters, digits, or the characters
  // - _ . @ $". Names that fail this rule are warned about but still emitted — the backend is the source of truth, so
  // client-side drop would force a customer SDK bump if the policy is ever relaxed.
  describe('operation name character set', () => {
    // Names outside the schema facet-path set (letters / digits / - _ . @ $) are warned about but still emitted: the
    // backend is the source of truth for what the schema actually allows, so client-side drop would force a customer
    // SDK bump if the backend ever relaxed the rule.
    it.each([
      ['space', 'user login'],
      ['slash', 'api/v1'],
      ['colon', 'checkout:step1'],
      ['comma', 'login,logout'],
      ['plus', 'a+b'],
      ['tab', 'login\ttwo'],
      ['Unicode', 'ログイン'],
      ['emoji', 'login🔐'],
    ])('warns but still emits events with names containing %s', (_label, name) => {
      operationCollection.getApi().startOperation(name);

      expect(rawRumEvents).toHaveLength(1);
      expect((rawRumEvents[0].data as RawRumVital).vital.name).toBe(name);
      expect(displayWarn).toHaveBeenCalledOnce();
      expect(vi.mocked(displayWarn).mock.calls[0][0]).toContain('does not match');
      expect(vi.mocked(displayWarn).mock.calls[0][0]).toContain('still be sent');
    });

    it.each([
      ['letters', 'login'],
      ['digits', 'step42'],
      ['hyphen', 'login-v2'],
      ['underscore', 'user_login'],
      ['dot', 'login.v2'],
      ['at', 'login@prod'],
      ['dollar', 'login$1'],
      ['mixed allowed', 'login-v2@1.0.0_step$1'],
      ['all digits', '12345'],
      ['uppercase', 'LOGIN'],
      ['mixed case', 'LoginV2'],
    ])('accepts names with %s without warning', (_label, name) => {
      operationCollection.getApi().startOperation(name);

      expect(rawRumEvents).toHaveLength(1);
      expect(displayWarn).not.toHaveBeenCalled();
      expect((rawRumEvents[0].data as RawRumVital).vital.name).toBe(name);
    });

    it('warns but still emits on succeedOperation with invalid characters', () => {
      operationCollection.getApi().succeedOperation('user login');
      expect(rawRumEvents).toHaveLength(1);
      expect((rawRumEvents[0].data as RawRumVital).vital.step_type).toBe('end');
      expect(displayWarn).toHaveBeenCalledOnce();
    });

    it('warns but still emits on failOperation with invalid characters', () => {
      operationCollection.getApi().failOperation('user login', 'error');
      expect(rawRumEvents).toHaveLength(1);
      const data = rawRumEvents[0].data as RawRumVital;
      expect(data.vital.step_type).toBe('end');
      expect(data.vital.failure_reason).toBe('error');
      expect(displayWarn).toHaveBeenCalledOnce();
    });

    it('does not restrict operationKey to the same character set', () => {
      // operation_key has no character-set constraint in the schema.
      operationCollection.getApi().startOperation('login', { operationKey: 'session-42 / user foo' });
      expect(rawRumEvents).toHaveLength(1);
      expect(displayWarn).not.toHaveBeenCalled();
      expect((rawRumEvents[0].data as RawRumVital).vital.operation_key).toBe('session-42 / user foo');
    });
  });

  // --- PAY-04, plus payload shape concerns not already covered by the public-API-dispatch group ---
  // PAY-01, PAY-02, PAY-03, PAY-07, PAY-08, PAY-09 and PAY-10 are covered by the API-01..API-04 tests above (every
  // call routes through the same `handle()`, so payload shape and dispatch are checked in a single test).
  describe('payload structure', () => {
    it.each(['error', 'abandoned', 'other'] as const)('PAY-04: failure reason %s serialises correctly', (reason) => {
      operationCollection.getApi().failOperation('login', reason);

      const data = rawRumEvents[0].data as RawRumVital;
      expect(data.vital.failure_reason).toBe(reason);
      expect(displayWarn).not.toHaveBeenCalled();
    });

    // Unknown / off-enum `failureReason` values can only reach this code path from JS callers that bypass the TS
    // signature. Mirror the name character-set policy: warn so the typo is visible in the developer console, but
    // still emit the event — `failure_reason` carries the most diagnostic value on a fail event, so dropping on a
    // typo would lose more signal than it protects, and the backend remains the source of truth on the enum policy.
    it.each([
      ['off-enum string', 'cancelled'],
      ['empty string', ''],
      ['whitespace', '   '],
      ['number', 42 as unknown as 'error'],
      ['null', null as unknown as 'error'],
      ['boolean', true as unknown as 'error'],
    ])('warns but still emits when failOperation receives a %s failure reason', (_label, reason) => {
      operationCollection.getApi().failOperation('login', reason as 'error');

      expect(rawRumEvents).toHaveLength(1);
      const data = rawRumEvents[0].data as RawRumVital;
      expect(data.vital.step_type).toBe('end');
      expect(data.vital.failure_reason).toBe(reason);
      expect(displayWarn).toHaveBeenCalledOnce();
      expect(vi.mocked(displayWarn).mock.calls[0][0]).toContain('failure reason');
      expect(vi.mocked(displayWarn).mock.calls[0][0]).toContain('still be sent');
    });

    it('captures a non-zero startTime from timeStampNow on the emitted raw event', () => {
      const before = Date.now();
      operationCollection.getApi().startOperation('login');
      const after = Date.now();

      const event = rawRumEvents[0];
      expect(event.startTime).toBeDefined();
      expect(event.startTime).toBeGreaterThanOrEqual(before);
      expect(event.startTime).toBeLessThanOrEqual(after);
      expect((event.data as RawRumVital).date).toBe(event.startTime);
    });

    it('omits vital.description when not provided', () => {
      operationCollection.getApi().startOperation('login');

      const data = rawRumEvents[0].data as RawRumVital;
      expect('description' in data.vital).toBe(false);
    });

    it('defaults context to an empty object when options.context is omitted', () => {
      operationCollection.getApi().startOperation('login');

      const data = rawRumEvents[0].data as RawRumVital;
      expect(data.context).toEqual({});
    });
  });

  // --- No-tracking behavior ---
  // Electron intentionally does NOT track active operations locally (matches browser-sdk / Android). Renderer events
  // flow through the bridge without updating main-process state, so any local tracking would produce false positives
  // on cross-process start/stop flows. Consequently the main process never emits "duplicate start" / "stop without
  // start" warnings.
  describe('no local tracking (cross-process safety)', () => {
    it('does not warn on duplicate start from the main process', () => {
      operationCollection.getApi().startOperation('login');
      operationCollection.getApi().startOperation('login');

      expect(rawRumEvents).toHaveLength(2);
      expect(displayError).not.toHaveBeenCalled();
    });

    it('does not warn on succeed without a prior start', () => {
      operationCollection.getApi().succeedOperation('login');

      expect(rawRumEvents).toHaveLength(1);
      expect(displayError).not.toHaveBeenCalled();
    });

    it('does not warn on fail without a prior start', () => {
      operationCollection.getApi().failOperation('login', 'error');

      expect(rawRumEvents).toHaveLength(1);
      const data = rawRumEvents[0].data as RawRumVital;
      expect(data.vital.step_type).toBe('end');
      expect(data.vital.failure_reason).toBe('error');
      expect(displayError).not.toHaveBeenCalled();
    });

    it('does not warn on double-stop', () => {
      const api = operationCollection.getApi();
      api.startOperation('login');
      api.succeedOperation('login');
      api.succeedOperation('login');

      expect(rawRumEvents).toHaveLength(3);
      expect(displayError).not.toHaveBeenCalled();
    });
  });

  // --- PAR-01: parallel operations (no warnings expected on either side) ---
  describe('parallel operations', () => {
    it('PAR-01: operations with same name and different keys emit independently', () => {
      const api = operationCollection.getApi();
      api.startOperation('upload', { operationKey: 'a' });
      api.startOperation('upload', { operationKey: 'b' });
      api.succeedOperation('upload', { operationKey: 'a' });
      api.failOperation('upload', 'error', { operationKey: 'b' });

      expect(rawRumEvents).toHaveLength(4);
      expect(displayError).not.toHaveBeenCalled();
      const payloads = rawRumEvents.map((e) => (e.data as RawRumVital).vital);
      expect(payloads[0]).toMatchObject({ step_type: 'start', operation_key: 'a' });
      expect(payloads[1]).toMatchObject({ step_type: 'start', operation_key: 'b' });
      expect(payloads[2]).toMatchObject({ step_type: 'end', operation_key: 'a' });
      expect(payloads[3]).toMatchObject({ step_type: 'end', operation_key: 'b', failure_reason: 'error' });
    });

    it('PAR-03: keyed and unkeyed with same name emit independently', () => {
      operationCollection.getApi().startOperation('login');
      operationCollection.getApi().startOperation('login', { operationKey: 'k1' });

      expect(rawRumEvents).toHaveLength(2);
      expect(displayError).not.toHaveBeenCalled();
    });
  });

  // --- EDGE cases ---
  describe('edge cases', () => {
    // EDGE-04 (Unicode) is intentionally omitted: the schema facet-path rule restricts names to ASCII letters / digits
    // / - _ . @ $, which excludes non-ASCII characters. The character-set test group above covers this.

    it('EDGE-05: long operation name is preserved', () => {
      const longName = 'a'.repeat(500);
      operationCollection.getApi().startOperation(longName);

      const data = rawRumEvents[0].data as RawRumVital;
      expect(data.vital.name).toBe(longName);
    });

    it('EDGE-06: schema-allowed special characters in operation name are preserved', () => {
      operationCollection.getApi().startOperation('login-v2@1.0.0');

      const data = rawRumEvents[0].data as RawRumVital;
      expect(data.vital.name).toBe('login-v2@1.0.0');
    });
  });

  describe('lifecycle', () => {
    it('stop() is callable without side effects (no owned subscriptions)', () => {
      operationCollection.stop();
      // Subsequent calls still work; collection has no torn-down state.
      operationCollection.getApi().startOperation('login');
      expect(rawRumEvents).toHaveLength(1);
    });
  });

  // The deprecated `*FeatureOperation` wrappers exist only for backwards compatibility with the early-preview API
  // name. They emit a one-time deprecation warning per method and forward to the canonical implementation. These tests
  // pin both the wrapping behavior and the warn-once policy so noisy callers don't drown the console.
  describe('deprecated *FeatureOperation wrappers', () => {
    it('startFeatureOperation forwards to startOperation and emits the same event', () => {
      operationCollection.getApi().startFeatureOperation('login');

      expect(rawRumEvents).toHaveLength(1);
      const data = rawRumEvents[0].data as RawRumVital;
      expect(data.vital.step_type).toBe('start');
      expect(data.vital.name).toBe('login');
    });

    it('succeedFeatureOperation forwards to succeedOperation and emits the same event', () => {
      operationCollection.getApi().succeedFeatureOperation('login');

      expect(rawRumEvents).toHaveLength(1);
      const data = rawRumEvents[0].data as RawRumVital;
      expect(data.vital.step_type).toBe('end');
      expect(data.vital.failure_reason).toBeUndefined();
    });

    it('failFeatureOperation forwards to failOperation and emits the same event', () => {
      operationCollection.getApi().failFeatureOperation('login', 'error');

      expect(rawRumEvents).toHaveLength(1);
      const data = rawRumEvents[0].data as RawRumVital;
      expect(data.vital.step_type).toBe('end');
      expect(data.vital.failure_reason).toBe('error');
    });

    it('forwards every option the canonical method accepts', () => {
      operationCollection
        .getApi()
        .startFeatureOperation('upload', { operationKey: 'k1', context: { foo: 'bar' }, description: 'desc' });

      const data = rawRumEvents[0].data as RawRumVital;
      expect(data.vital.operation_key).toBe('k1');
      expect(data.vital.description).toBe('desc');
      expect(data.context).toEqual({ foo: 'bar' });
    });

    it('emits a deprecation warning the first time each *FeatureOperation method is called', () => {
      const api = operationCollection.getApi();
      api.startFeatureOperation('login');
      api.succeedFeatureOperation('login');
      api.failFeatureOperation('login', 'error');

      expect(displayWarn).toHaveBeenCalledTimes(3);
      const messages = vi.mocked(displayWarn).mock.calls.map((c) => c[0] as string);
      expect(messages.some((m) => m.includes('startFeatureOperation') && m.includes('startOperation'))).toBe(true);
      expect(messages.some((m) => m.includes('succeedFeatureOperation') && m.includes('succeedOperation'))).toBe(true);
      expect(messages.some((m) => m.includes('failFeatureOperation') && m.includes('failOperation'))).toBe(true);
    });

    it('warns at most once per deprecated method name (warn-once policy)', () => {
      const api = operationCollection.getApi();
      api.startFeatureOperation('login');
      api.startFeatureOperation('login');
      api.startFeatureOperation('login');

      // The deprecation warning fires once; the events are still emitted.
      expect(displayWarn).toHaveBeenCalledOnce();
      expect(rawRumEvents).toHaveLength(3);
    });

    it('canonical methods do not trigger the deprecation warning', () => {
      const api = operationCollection.getApi();
      api.startOperation('login');
      api.succeedOperation('login');
      api.failOperation('login', 'error');

      expect(displayWarn).not.toHaveBeenCalled();
      expect(rawRumEvents).toHaveLength(3);
    });

    it('still routes through validateArgs (blank name on a deprecated wrapper is rejected)', () => {
      operationCollection.getApi().startFeatureOperation('');
      expect(rawRumEvents).toHaveLength(0);
      // The deprecation warning still fires before validation.
      expect(displayWarn).toHaveBeenCalledOnce();
      expect(displayError).toHaveBeenCalledOnce();
      expect(vi.mocked(displayError).mock.calls[0][0]).toContain('startOperation: operation name cannot be empty');
    });
  });
});
