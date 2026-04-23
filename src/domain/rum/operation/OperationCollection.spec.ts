import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OperationCollection } from './OperationCollection';
import { EventFormat, EventKind, EventManager, type RawRumEvent } from '../../../event';
import type { RawRumVital } from '../rawRumData.types';
import { displayError } from '../../../tools/display';

vi.mock('../../../tools/display', () => ({
  displayError: vi.fn(),
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
    it('API-01: startFeatureOperation emits a start vital event', () => {
      operationCollection.getApi().startFeatureOperation('login');

      expect(rawRumEvents).toHaveLength(1);
      const data = rawRumEvents[0].data as RawRumVital;
      expect(data.type).toBe('vital');
      expect(data.vital.type).toBe('operation_step');
      expect(data.vital.step_type).toBe('start');
      expect(data.vital.name).toBe('login');
      expect(data.vital.failure_reason).toBeUndefined();
      expect(data.vital.operation_key).toBeUndefined();
      expect(data.vital.id).toMatch(UUID_REGEX);
    });

    it('API-02: succeedFeatureOperation emits an end vital event without failure_reason', () => {
      operationCollection.getApi().succeedFeatureOperation('login');

      expect(rawRumEvents).toHaveLength(1);
      const data = rawRumEvents[0].data as RawRumVital;
      expect(data.vital.step_type).toBe('end');
      expect(data.vital.failure_reason).toBeUndefined();
    });

    it('API-03: failFeatureOperation emits an end vital event with failure_reason', () => {
      operationCollection.getApi().failFeatureOperation('login', 'error');

      expect(rawRumEvents).toHaveLength(1);
      const data = rawRumEvents[0].data as RawRumVital;
      expect(data.vital.step_type).toBe('end');
      expect(data.vital.failure_reason).toBe('error');
    });

    it('API-04: operationKey is forwarded to the event payload', () => {
      operationCollection.getApi().startFeatureOperation('login', { operationKey: 'abc' });

      const data = rawRumEvents[0].data as RawRumVital;
      expect(data.vital.operation_key).toBe('abc');
    });

    it('API-05: options.context is forwarded to the event context', () => {
      operationCollection.getApi().startFeatureOperation('login', { context: { key: 'value' } });

      const data = rawRumEvents[0].data as RawRumVital;
      expect(data.context).toEqual({ key: 'value' });
    });

    it('API-06: each call produces a unique vital.id', () => {
      operationCollection.getApi().startFeatureOperation('login');
      operationCollection.getApi().startFeatureOperation('login');

      expect(rawRumEvents).toHaveLength(2);
      const firstId = (rawRumEvents[0].data as RawRumVital).vital.id;
      const secondId = (rawRumEvents[1].data as RawRumVital).vital.id;
      expect(firstId).not.toBe(secondId);
    });

    it('forwards description into the vital section when provided', () => {
      operationCollection.getApi().startFeatureOperation('login', { description: 'user tapped login' });

      const data = rawRumEvents[0].data as RawRumVital;
      expect(data.vital.description).toBe('user tapped login');
    });
  });

  // --- VAL-01..VAL-07 ---
  describe('input validation', () => {
    it('VAL-01: empty name is rejected and no event is emitted', () => {
      // The backend rejects blank/empty names with its own non-empty
      // precondition before evaluating the character-set regex; drop
      // client-side to match.
      operationCollection.getApi().startFeatureOperation('');

      expect(rawRumEvents).toHaveLength(0);
      expect(displayError).toHaveBeenCalledOnce();
      expect(vi.mocked(displayError).mock.calls[0][0]).toContain('operation name cannot be empty');
    });

    it('VAL-02: whitespace-only name is rejected and no event is emitted', () => {
      operationCollection.getApi().startFeatureOperation('   ');

      expect(rawRumEvents).toHaveLength(0);
      expect(displayError).toHaveBeenCalledOnce();
      expect(vi.mocked(displayError).mock.calls[0][0]).toContain('operation name cannot be empty');
    });

    it('VAL-03: empty operationKey is rejected as blank', () => {
      operationCollection.getApi().startFeatureOperation('login', { operationKey: '' });

      expect(rawRumEvents).toHaveLength(0);
      expect(displayError).toHaveBeenCalledOnce();
      expect(vi.mocked(displayError).mock.calls[0][0]).toContain('operation key cannot be empty');
    });

    it('VAL-04: whitespace-only operationKey is rejected', () => {
      operationCollection.getApi().startFeatureOperation('login', { operationKey: '   ' });

      expect(rawRumEvents).toHaveLength(0);
      expect(displayError).toHaveBeenCalledOnce();
    });

    it('VAL-05: undefined operationKey is valid and results in an unkeyed operation', () => {
      operationCollection.getApi().startFeatureOperation('login', { operationKey: undefined });

      expect(rawRumEvents).toHaveLength(1);
      const data = rawRumEvents[0].data as RawRumVital;
      expect(data.vital.operation_key).toBeUndefined();
      expect(displayError).not.toHaveBeenCalled();
    });

    it('VAL-07: blank name on succeedFeatureOperation is rejected', () => {
      operationCollection.getApi().succeedFeatureOperation('');
      expect(rawRumEvents).toHaveLength(0);
      expect(displayError).toHaveBeenCalledOnce();
    });

    it('VAL-07: blank name on failFeatureOperation is rejected', () => {
      operationCollection.getApi().failFeatureOperation('', 'error');
      expect(rawRumEvents).toHaveLength(0);
      expect(displayError).toHaveBeenCalledOnce();
    });

    it('VAL-07: blank operationKey is rejected on succeedFeatureOperation', () => {
      operationCollection.getApi().succeedFeatureOperation('login', { operationKey: '' });
      expect(rawRumEvents).toHaveLength(0);
      expect(displayError).toHaveBeenCalledOnce();
      expect(vi.mocked(displayError).mock.calls[0][0]).toContain('operation key cannot be empty');
    });

    it('VAL-07: blank operationKey is rejected on failFeatureOperation', () => {
      operationCollection.getApi().failFeatureOperation('login', 'error', { operationKey: '   ' });
      expect(rawRumEvents).toHaveLength(0);
      expect(displayError).toHaveBeenCalledOnce();
      expect(vi.mocked(displayError).mock.calls[0][0]).toContain('operation key cannot be empty');
    });
  });

  // --- Name character-set validation (schema facet-path rule) ---
  // The authoritative _vital-common-schema.json says vital.name "must contain
  // only letters, digits, or the characters - _ . @ $". Names that fail this
  // rule are warned about but still emitted — the backend is the source of
  // truth, so client-side drop would force a customer SDK bump if the policy
  // is ever relaxed.
  describe('operation name character set', () => {
    // Names outside the schema facet-path set (letters / digits / - _ . @ $)
    // are warned about but still emitted: the backend is the source of truth
    // for what the schema actually allows, so client-side drop would force a
    // customer SDK bump if the backend ever relaxed the rule.
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
      operationCollection.getApi().startFeatureOperation(name);

      expect(rawRumEvents).toHaveLength(1);
      expect((rawRumEvents[0].data as RawRumVital).vital.name).toBe(name);
      expect(displayError).toHaveBeenCalledOnce();
      expect(vi.mocked(displayError).mock.calls[0][0]).toContain('does not match');
      expect(vi.mocked(displayError).mock.calls[0][0]).toContain('still be sent');
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
      operationCollection.getApi().startFeatureOperation(name);

      expect(rawRumEvents).toHaveLength(1);
      expect(displayError).not.toHaveBeenCalled();
      expect((rawRumEvents[0].data as RawRumVital).vital.name).toBe(name);
    });

    it('warns but still emits on succeedFeatureOperation with invalid characters', () => {
      operationCollection.getApi().succeedFeatureOperation('user login');
      expect(rawRumEvents).toHaveLength(1);
      expect((rawRumEvents[0].data as RawRumVital).vital.step_type).toBe('end');
      expect(displayError).toHaveBeenCalledOnce();
    });

    it('warns but still emits on failFeatureOperation with invalid characters', () => {
      operationCollection.getApi().failFeatureOperation('user login', 'error');
      expect(rawRumEvents).toHaveLength(1);
      const data = rawRumEvents[0].data as RawRumVital;
      expect(data.vital.step_type).toBe('end');
      expect(data.vital.failure_reason).toBe('error');
      expect(displayError).toHaveBeenCalledOnce();
    });

    it('does not restrict operationKey to the same character set', () => {
      // operation_key has no character-set constraint in the schema.
      operationCollection.getApi().startFeatureOperation('login', { operationKey: 'session-42 / user foo' });
      expect(rawRumEvents).toHaveLength(1);
      expect(displayError).not.toHaveBeenCalled();
      expect((rawRumEvents[0].data as RawRumVital).vital.operation_key).toBe('session-42 / user foo');
    });
  });

  // --- PAY-01..PAY-10 ---
  describe('payload structure', () => {
    it('PAY-01: start payload shape', () => {
      operationCollection.getApi().startFeatureOperation('login');

      const data = rawRumEvents[0].data as RawRumVital;
      expect(data.type).toBe('vital');
      expect(data.vital.type).toBe('operation_step');
      expect(data.vital.step_type).toBe('start');
      expect(data.vital.failure_reason).toBeUndefined();
    });

    it('PAY-02: succeed payload shape', () => {
      operationCollection.getApi().succeedFeatureOperation('login');

      const data = rawRumEvents[0].data as RawRumVital;
      expect(data.vital.step_type).toBe('end');
      expect(data.vital.failure_reason).toBeUndefined();
    });

    it('PAY-03: fail payload shape', () => {
      operationCollection.getApi().failFeatureOperation('login', 'error');

      const data = rawRumEvents[0].data as RawRumVital;
      expect(data.vital.step_type).toBe('end');
      expect(data.vital.failure_reason).toBe('error');
    });

    it.each(['error', 'abandoned', 'other'] as const)('PAY-04: failure reason %s serialises correctly', (reason) => {
      operationCollection.getApi().failFeatureOperation('login', reason);

      const data = rawRumEvents[0].data as RawRumVital;
      expect(data.vital.failure_reason).toBe(reason);
    });

    it('PAY-07: vital.id matches UUID v4 pattern', () => {
      operationCollection.getApi().startFeatureOperation('login');

      const data = rawRumEvents[0].data as RawRumVital;
      expect(data.vital.id).toMatch(UUID_REGEX);
    });

    it('PAY-08: vital.name matches the input', () => {
      operationCollection.getApi().startFeatureOperation('checkout');

      const data = rawRumEvents[0].data as RawRumVital;
      expect(data.vital.name).toBe('checkout');
    });

    it('PAY-09: unkeyed operation omits operation_key', () => {
      operationCollection.getApi().startFeatureOperation('login');

      const data = rawRumEvents[0].data as RawRumVital;
      expect('operation_key' in data.vital).toBe(false);
    });

    it('PAY-10: keyed operation includes operation_key', () => {
      operationCollection.getApi().startFeatureOperation('login', { operationKey: 'abc' });

      const data = rawRumEvents[0].data as RawRumVital;
      expect(data.vital.operation_key).toBe('abc');
    });

    it('captures a non-zero startTime from timeStampNow on the emitted raw event', () => {
      const before = Date.now();
      operationCollection.getApi().startFeatureOperation('login');
      const after = Date.now();

      const event = rawRumEvents[0];
      expect(event.startTime).toBeDefined();
      expect(event.startTime).toBeGreaterThanOrEqual(before);
      expect(event.startTime).toBeLessThanOrEqual(after);
      expect((event.data as RawRumVital).date).toBe(event.startTime);
    });

    it('omits vital.description when not provided', () => {
      operationCollection.getApi().startFeatureOperation('login');

      const data = rawRumEvents[0].data as RawRumVital;
      expect('description' in data.vital).toBe(false);
    });

    it('defaults context to an empty object when options.context is omitted', () => {
      operationCollection.getApi().startFeatureOperation('login');

      const data = rawRumEvents[0].data as RawRumVital;
      expect(data.context).toEqual({});
    });
  });

  // --- No-tracking behavior ---
  // Electron intentionally does NOT track active operations locally (matches
  // browser-sdk / Android). Renderer events flow through the bridge without
  // updating main-process state, so any local tracking would produce false
  // positives on cross-process start/stop flows. Consequently the main process
  // never emits "duplicate start" / "stop without start" warnings.
  describe('no local tracking (cross-process safety)', () => {
    it('does not warn on duplicate start from the main process', () => {
      operationCollection.getApi().startFeatureOperation('login');
      operationCollection.getApi().startFeatureOperation('login');

      expect(rawRumEvents).toHaveLength(2);
      expect(displayError).not.toHaveBeenCalled();
    });

    it('does not warn on succeed without a prior start', () => {
      operationCollection.getApi().succeedFeatureOperation('login');

      expect(rawRumEvents).toHaveLength(1);
      expect(displayError).not.toHaveBeenCalled();
    });

    it('does not warn on fail without a prior start', () => {
      operationCollection.getApi().failFeatureOperation('login', 'error');

      expect(rawRumEvents).toHaveLength(1);
      const data = rawRumEvents[0].data as RawRumVital;
      expect(data.vital.step_type).toBe('end');
      expect(data.vital.failure_reason).toBe('error');
      expect(displayError).not.toHaveBeenCalled();
    });

    it('does not warn on double-stop', () => {
      const api = operationCollection.getApi();
      api.startFeatureOperation('login');
      api.succeedFeatureOperation('login');
      api.succeedFeatureOperation('login');

      expect(rawRumEvents).toHaveLength(3);
      expect(displayError).not.toHaveBeenCalled();
    });
  });

  // --- PAR-01: parallel operations (no warnings expected on either side) ---
  describe('parallel operations', () => {
    it('PAR-01: operations with same name and different keys emit independently', () => {
      const api = operationCollection.getApi();
      api.startFeatureOperation('upload', { operationKey: 'a' });
      api.startFeatureOperation('upload', { operationKey: 'b' });
      api.succeedFeatureOperation('upload', { operationKey: 'a' });
      api.failFeatureOperation('upload', 'error', { operationKey: 'b' });

      expect(rawRumEvents).toHaveLength(4);
      expect(displayError).not.toHaveBeenCalled();
      const payloads = rawRumEvents.map((e) => (e.data as RawRumVital).vital);
      expect(payloads[0]).toMatchObject({ step_type: 'start', operation_key: 'a' });
      expect(payloads[1]).toMatchObject({ step_type: 'start', operation_key: 'b' });
      expect(payloads[2]).toMatchObject({ step_type: 'end', operation_key: 'a' });
      expect(payloads[3]).toMatchObject({ step_type: 'end', operation_key: 'b', failure_reason: 'error' });
    });

    it('PAR-03: keyed and unkeyed with same name emit independently', () => {
      operationCollection.getApi().startFeatureOperation('login');
      operationCollection.getApi().startFeatureOperation('login', { operationKey: 'k1' });

      expect(rawRumEvents).toHaveLength(2);
      expect(displayError).not.toHaveBeenCalled();
    });
  });

  // --- EDGE cases ---
  describe('edge cases', () => {
    // EDGE-04 (Unicode) is intentionally omitted: the schema facet-path rule
    // restricts names to ASCII letters/digits/- _ . @ $, which excludes
    // non-ASCII characters. The character-set test group above covers this.

    it('EDGE-05: long operation name is preserved', () => {
      const longName = 'a'.repeat(500);
      operationCollection.getApi().startFeatureOperation(longName);

      const data = rawRumEvents[0].data as RawRumVital;
      expect(data.vital.name).toBe(longName);
    });

    it('EDGE-06: schema-allowed special characters in operation name are preserved', () => {
      operationCollection.getApi().startFeatureOperation('login-v2@1.0.0');

      const data = rawRumEvents[0].data as RawRumVital;
      expect(data.vital.name).toBe('login-v2@1.0.0');
    });
  });

  describe('lifecycle', () => {
    it('stop() is callable without side effects (no owned subscriptions)', () => {
      operationCollection.stop();
      // Subsequent calls still work; collection has no torn-down state.
      operationCollection.getApi().startFeatureOperation('login');
      expect(rawRumEvents).toHaveLength(1);
    });
  });
});
