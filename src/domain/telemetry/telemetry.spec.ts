import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addError, callMonitored, monitor, startTelemetry, stopTelemetry } from './telemetry';
import { createTestConfiguration } from '../../mocks.specUtil';
import { EventManager, RawEvent, EventKind, LifecycleKind } from '../../event';

interface RawTelemetryData {
  type: 'telemetry';
  telemetry: {
    type: 'log';
    status: 'error';
    message: string;
    error?: { stack?: string; kind?: string };
  };
}

describe('telemetry', () => {
  let eventManager: EventManager;
  let notifiedEvents: RawTelemetryData[];

  beforeEach(() => {
    eventManager = new EventManager();
    notifiedEvents = [];
    eventManager.registerHandler<RawEvent>({
      canHandle: (event) => event.kind === EventKind.RAW,
      handle: (event) => notifiedEvents.push(event.data as RawTelemetryData),
    });
  });

  afterEach(() => {
    stopTelemetry();
  });

  describe('monitor integration', () => {
    it('captures errors from monitored functions', () => {
      const config = createTestConfiguration();
      startTelemetry(eventManager, config);

      const monitoredFn = monitor(() => {
        throw new Error('monitored error');
      });

      monitoredFn();

      expect(notifiedEvents).toHaveLength(1);
      expect(notifiedEvents[0].telemetry.message).toBe('monitored error');
    });

    it('captures errors from callMonitored', () => {
      const config = createTestConfiguration();
      startTelemetry(eventManager, config);

      callMonitored(() => {
        throw new Error('callMonitored error');
      });

      expect(notifiedEvents).toHaveLength(1);
      expect(notifiedEvents[0].telemetry.message).toBe('callMonitored error');
    });
  });

  describe('addError', () => {
    it('notifies with formatted event', () => {
      const config = createTestConfiguration();
      startTelemetry(eventManager, config);

      const testError = new Error('Test error message');
      testError.stack = 'Error: Test error message\n    at test.ts:1:1';
      addError(testError);

      expect(notifiedEvents).toHaveLength(1);
      const event = notifiedEvents[0];

      expect(event.type).toBe('telemetry');
      expect(event.telemetry.type).toBe('log');
      expect(event.telemetry.status).toBe('error');
      expect(event.telemetry.message).toBe('Test error message');
      expect(event.telemetry.error?.stack).toBe('Error: Test error message\n    at test.ts:1:1');
      expect(event.telemetry.error?.kind).toBe('Error');
    });

    it('handles string errors', () => {
      const config = createTestConfiguration();
      startTelemetry(eventManager, config);

      addError('string error message');

      expect(notifiedEvents).toHaveLength(1);
      expect(notifiedEvents[0].telemetry.message).toBe('Uncaught "string error message"');
      expect(notifiedEvents[0].telemetry.error).toBeUndefined();
    });

    it('handles object errors', () => {
      const config = createTestConfiguration();
      startTelemetry(eventManager, config);

      addError({ code: 'ERR_123', detail: 'something failed' });

      expect(notifiedEvents).toHaveLength(1);
      expect(notifiedEvents[0].telemetry.message).toBe('Uncaught {"code":"ERR_123","detail":"something failed"}');
    });
  });

  describe('sampling', () => {
    it('does not notify when sample rate is 0', () => {
      const config = createTestConfiguration({ telemetrySampleRate: 0 });
      startTelemetry(eventManager, config);

      addError(new Error('should not be sent'));

      expect(notifiedEvents).toHaveLength(0);
    });

    it('notifies when sample rate is 100', () => {
      const config = createTestConfiguration({ telemetrySampleRate: 100 });
      startTelemetry(eventManager, config);

      addError(new Error('should be sent'));

      expect(notifiedEvents).toHaveLength(1);
    });
  });

  describe('event limitation', () => {
    it('stops notifying after 100 events per session', () => {
      const config = createTestConfiguration();
      startTelemetry(eventManager, config);

      for (let i = 0; i < 150; i++) {
        addError(new Error(`error ${i}`));
      }

      expect(notifiedEvents).toHaveLength(100);
    });

    it('resets event count on session renewal', () => {
      const config = createTestConfiguration();
      startTelemetry(eventManager, config);

      // Fill up the limit
      for (let i = 0; i < 100; i++) {
        addError(new Error(`error ${i}`));
      }
      expect(notifiedEvents).toHaveLength(100);

      // This should be ignored (limit reached)
      addError(new Error('should be ignored'));
      expect(notifiedEvents).toHaveLength(100);

      // Simulate session renewal
      eventManager.notify({
        kind: EventKind.LIFECYCLE,
        lifecycle: LifecycleKind.SESSION_RENEW,
      });

      // Now we can send more events
      addError(new Error('after renewal'));
      expect(notifiedEvents).toHaveLength(101);
    });
  });

  describe('stopTelemetry', () => {
    it('clears instance so addError becomes no-op', () => {
      const config = createTestConfiguration();
      startTelemetry(eventManager, config);
      addError(new Error('before stop'));

      expect(notifiedEvents).toHaveLength(1);

      stopTelemetry();
      addError(new Error('after stop'));

      expect(notifiedEvents).toHaveLength(1);
    });
  });
});
