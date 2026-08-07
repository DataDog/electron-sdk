import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addConfiguration,
  addError,
  addUsage,
  callMonitored,
  monitor,
  startTelemetry,
  stopTelemetry,
} from './Telemetry';
import { createTestConfiguration } from '../../mocks.specUtil';
import { EventManager, RawEvent, EventKind, LifecycleKind } from '../../event';
import { RawTelemetryData, RawTelemetryError } from './rawTelemetryData.types';

describe('telemetry', () => {
  let eventManager: EventManager;
  let notifiedEvents: RawTelemetryData[];

  /** Narrow to error events, the only type carrying `message`. */
  function errorEvent(index: number): RawTelemetryError['telemetry'] {
    const event = notifiedEvents[index];
    if (event.telemetry.type !== 'log') {
      throw new Error(`Expected a log event at index ${index}, got '${event.telemetry.type}'`);
    }
    return event.telemetry;
  }

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
      expect(errorEvent(0).message).toBe('monitored error');
    });

    it('captures errors from callMonitored', () => {
      const config = createTestConfiguration();
      startTelemetry(eventManager, config);

      callMonitored(() => {
        throw new Error('callMonitored error');
      });

      expect(notifiedEvents).toHaveLength(1);
      expect(errorEvent(0).message).toBe('callMonitored error');
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
      expect(notifiedEvents[0].type).toBe('telemetry');

      const telemetry = errorEvent(0);
      expect(telemetry.type).toBe('log');
      expect(telemetry.status).toBe('error');
      expect(telemetry.message).toBe('Test error message');
      expect(telemetry.error?.stack).toBe('Error: Test error message\n    at test.ts:1:1');
      expect(telemetry.error?.kind).toBe('Error');
    });

    it('handles string errors', () => {
      const config = createTestConfiguration();
      startTelemetry(eventManager, config);

      addError('string error message');

      expect(notifiedEvents).toHaveLength(1);
      expect(errorEvent(0).message).toBe('Uncaught "string error message"');
      expect(errorEvent(0).error).toBeUndefined();
    });

    it('handles object errors', () => {
      const config = createTestConfiguration();
      startTelemetry(eventManager, config);

      addError({ code: 'ERR_123', detail: 'something failed' });

      expect(notifiedEvents).toHaveLength(1);
      expect(errorEvent(0).message).toBe('Uncaught {"code":"ERR_123","detail":"something failed"}');
    });
  });

  describe('addConfiguration', () => {
    it('notifies with a configuration event', () => {
      const config = createTestConfiguration();
      startTelemetry(eventManager, config);

      addConfiguration({ session_sample_rate: 42, use_proxy: true });

      expect(notifiedEvents).toHaveLength(1);
      expect(notifiedEvents[0]).toMatchObject({
        type: 'telemetry',
        telemetry: {
          type: 'configuration',
          configuration: { session_sample_rate: 42, use_proxy: true },
        },
      });
    });
  });

  describe('addUsage', () => {
    it('notifies with a usage event', () => {
      const config = createTestConfiguration();
      startTelemetry(eventManager, config);

      addUsage({ feature: 'stop-session' });

      expect(notifiedEvents).toHaveLength(1);
      expect(notifiedEvents[0]).toMatchObject({
        type: 'telemetry',
        telemetry: { type: 'usage', usage: { feature: 'stop-session' } },
      });
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

    it('drops configuration events when their rate is 0, keeping errors', () => {
      const config = createTestConfiguration({ telemetryConfigurationSampleRate: 0 });
      startTelemetry(eventManager, config);

      addConfiguration({ session_sample_rate: 100 });
      addError(new Error('still sent'));

      expect(notifiedEvents).toHaveLength(1);
      expect(errorEvent(0).message).toBe('still sent');
    });

    it('drops usage events when their rate is 0, keeping errors', () => {
      const config = createTestConfiguration({ telemetryUsageSampleRate: 0 });
      startTelemetry(eventManager, config);

      addUsage({ feature: 'stop-session' });
      addError(new Error('still sent'));

      expect(notifiedEvents).toHaveLength(1);
      expect(errorEvent(0).message).toBe('still sent');
    });

    it('drops every type when the base telemetry rate is 0, whatever the per-type rates', () => {
      const config = createTestConfiguration({
        telemetrySampleRate: 0,
        telemetryConfigurationSampleRate: 100,
        telemetryUsageSampleRate: 100,
      });
      startTelemetry(eventManager, config);

      addError(new Error('dropped'));
      addConfiguration({ session_sample_rate: 100 });
      addUsage({ feature: 'stop-session' });

      expect(notifiedEvents).toHaveLength(0);
    });
  });

  describe('effective_sample_rate', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('reports the base rate for errors and the combined rate for configuration and usage', () => {
      // Always draw in, so the reported rate can be asserted regardless of chance.
      vi.spyOn(Math, 'random').mockReturnValue(0);
      const config = createTestConfiguration({
        telemetrySampleRate: 50,
        telemetryConfigurationSampleRate: 50,
        telemetryUsageSampleRate: 10,
      });
      startTelemetry(eventManager, config);

      addError(new Error('sampled'));
      addConfiguration({ session_sample_rate: 100 });
      addUsage({ feature: 'stop-session' });

      expect(notifiedEvents).toHaveLength(3);
      expect(notifiedEvents[0].effective_sample_rate).toBe(50);
      expect(notifiedEvents[1].effective_sample_rate).toBe(25);
      expect(notifiedEvents[2].effective_sample_rate).toBe(5);
    });
  });

  describe('deduplication', () => {
    it('sends an identical event only once per session', () => {
      const config = createTestConfiguration();
      startTelemetry(eventManager, config);

      const error = new Error('repeated');
      error.stack = 'Error: repeated\n    at test.ts:1:1';
      addError(error);
      addError(error);
      addError(error);

      expect(notifiedEvents).toHaveLength(1);
    });

    it('sends events that differ', () => {
      const config = createTestConfiguration();
      startTelemetry(eventManager, config);

      addError(new Error('first'));
      addError(new Error('second'));

      expect(notifiedEvents).toHaveLength(2);
    });

    it('deduplicates usage events per feature', () => {
      const config = createTestConfiguration();
      startTelemetry(eventManager, config);

      addUsage({ feature: 'stop-session' });
      addUsage({ feature: 'stop-session' });
      addUsage({ feature: 'add-error' });

      expect(notifiedEvents).toHaveLength(2);
    });

    it('allows a repeated event again after session renewal', () => {
      const config = createTestConfiguration();
      startTelemetry(eventManager, config);

      addUsage({ feature: 'stop-session' });
      addUsage({ feature: 'stop-session' });
      expect(notifiedEvents).toHaveLength(1);

      eventManager.notify({ kind: EventKind.LIFECYCLE, lifecycle: LifecycleKind.SESSION_RENEW });

      addUsage({ feature: 'stop-session' });
      expect(notifiedEvents).toHaveLength(2);
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

    it('still sends the configuration event once the cap is reached', () => {
      const config = createTestConfiguration();
      startTelemetry(eventManager, config);

      for (let i = 0; i < 100; i++) {
        addError(new Error(`error ${i}`));
      }
      expect(notifiedEvents).toHaveLength(100);

      addConfiguration({ session_sample_rate: 100 });

      expect(notifiedEvents).toHaveLength(101);
      expect(notifiedEvents[100].telemetry.type).toBe('configuration');
    });

    it('does not let configuration events consume the cap', () => {
      const config = createTestConfiguration();
      startTelemetry(eventManager, config);

      addConfiguration({ session_sample_rate: 100 });
      for (let i = 0; i < 100; i++) {
        addError(new Error(`error ${i}`));
      }

      // 100 errors plus the exempt configuration event.
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

    it('detaches monitor error collection so monitored errors are dropped', () => {
      const config = createTestConfiguration();
      startTelemetry(eventManager, config);
      stopTelemetry();

      const monitoredFn = monitor(() => {
        throw new Error('post-stop monitor error');
      });
      monitoredFn();

      expect(notifiedEvents).toHaveLength(0);
    });
  });
});
