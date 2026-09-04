import { beforeEach, describe, expect, it, vi } from 'vitest';
import { reportConfiguration, type ConfigurationTelemetryContext } from './configurationTelemetry';
import { addConfiguration } from './Telemetry';
import type { RawTelemetryConfigurationData } from './rawTelemetryData.types';
import type { Configuration } from '../../config';
import { BatchSizes, BatchUploadFrequencies, buildConfiguration } from '../../config';
import { createTestConfiguration } from '../../mocks.specUtil';

let appReady: boolean;
let displayCount: number;

vi.mock('electron', () => ({
  app: { isReady: () => appReady },
  screen: {
    getAllDisplays: () => {
      if (!appReady) {
        throw new Error('The screen module cannot be used before the app ready event');
      }
      return Array.from({ length: displayCount }, () => ({}));
    },
  },
}));

vi.mock('./Telemetry', () => ({ addConfiguration: vi.fn() }));

/** Reports the configuration and returns what reached telemetry. */
function report(
  configuration: Configuration,
  context: Partial<ConfigurationTelemetryContext> = {}
): RawTelemetryConfigurationData {
  reportConfiguration(configuration, { useTracing: false, ...context });
  expect(addConfiguration).toHaveBeenCalledTimes(1);
  return vi.mocked(addConfiguration).mock.calls[0][0];
}

describe('reportConfiguration', () => {
  beforeEach(() => {
    vi.mocked(addConfiguration).mockClear();
    appReady = true;
    displayCount = 1;
  });

  it('reports the configured sample rates', () => {
    const configuration = createTestConfiguration({
      sessionSampleRate: 42,
      traceSampleRate: 75,
      sessionReplaySampleRate: 25,
      telemetrySampleRate: 30,
      telemetryConfigurationSampleRate: 20,
      telemetryUsageSampleRate: 10,
      profilingSampleRate: 5,
    });

    expect(report(configuration)).toMatchObject({
      session_sample_rate: 42,
      trace_sample_rate: 75,
      session_replay_sample_rate: 25,
      telemetry_sample_rate: 30,
      telemetry_configuration_sample_rate: 20,
      telemetry_usage_sample_rate: 10,
      profiling_sample_rate: 5,
    });
  });

  it('reports the privacy level applied to renderers', () => {
    const configuration = createTestConfiguration({ defaultPrivacyLevel: 'mask-user-input' });

    expect(report(configuration)).toMatchObject({
      default_privacy_level: 'mask-user-input',
    });
  });

  describe('use_proxy', () => {
    it('is true when a proxy is configured', () => {
      const configuration = createTestConfiguration({ proxy: 'https://proxy.example.com' });

      expect(report(configuration).use_proxy).toBe(true);
    });

    it('is false when no proxy is configured', () => {
      const configuration = createTestConfiguration();

      expect(report(configuration).use_proxy).toBe(false);
    });
  });

  // The schema's batch_size is a window duration in milliseconds. Electron's batch window is the
  // upload period, so both fields carry it. The SDK's own byte-threshold `batchSize` option is a
  // different axis with no schema field, and must never leak into either.
  describe('batch window', () => {
    it('reports the configured frequency in milliseconds, in both fields', () => {
      const configuration = createTestConfiguration({ uploadFrequency: 'RARE' });

      expect(report(configuration)).toMatchObject({
        batch_size: BatchUploadFrequencies.RARE,
        batch_upload_frequency: BatchUploadFrequencies.RARE,
      });
    });

    it('reports the effective default when the option is omitted at init, not undefined', () => {
      const configuration = buildConfiguration({
        clientToken: 'token',
        applicationId: 'app',
        site: 'datadoghq.com',
        service: 'service',
        allowedRendererHosts: [],
      })!;

      expect(report(configuration)).toMatchObject({
        batch_size: BatchUploadFrequencies.NORMAL,
        batch_upload_frequency: BatchUploadFrequencies.NORMAL,
      });
    });

    it('never reports the byte-threshold batchSize option', () => {
      const configuration = createTestConfiguration({ batchSize: 'LARGE', uploadFrequency: 'NORMAL' });

      const result = report(configuration);

      expect(result.batch_size).toBe(BatchUploadFrequencies.NORMAL);
      expect(result.batch_size).not.toBe(BatchSizes.LARGE);
    });
  });

  describe('tracing', () => {
    it('reports the Datadog tracer api and its version when tracing is on', () => {
      const configuration = createTestConfiguration();

      expect(report(configuration, { useTracing: true, tracerVersion: '5.109.0' })).toMatchObject({
        use_tracing: true,
        tracer_api: 'Datadog',
        tracer_api_version: '5.109.0',
      });
    });

    it('omits the version when dd-trace loaded but its manifest could not be read', () => {
      const configuration = createTestConfiguration();

      const result = report(configuration, { useTracing: true, tracerVersion: undefined });

      expect(result.tracer_api).toBe('Datadog');
      expect(result.tracer_api_version).toBeUndefined();
    });

    it('omits the tracer api when tracing is off', () => {
      const configuration = createTestConfiguration();

      const result = report(configuration, { useTracing: false, tracerVersion: '5.109.0' });

      expect(result.use_tracing).toBe(false);
      expect(result.tracer_api).toBeUndefined();
      expect(result.tracer_api_version).toBeUndefined();
    });
  });

  describe('use_trace_sampling_rules', () => {
    it('is true when trace sampling rules are configured', () => {
      const configuration = createTestConfiguration({
        traceSamplingRules: [{ name: 'electron.main.handle', sampleRate: 0 }],
      });

      expect(report(configuration).use_trace_sampling_rules).toBe(true);
    });

    it('is false when no trace sampling rules are configured', () => {
      expect(report(createTestConfiguration()).use_trace_sampling_rules).toBe(false);
    });
  });

  describe('use_before_send', () => {
    it('reports whether beforeSendRum is configured', () => {
      expect(report(createTestConfiguration({ beforeSendRum: () => true })).use_before_send).toBe(true);
      vi.mocked(addConfiguration).mockClear();
      expect(report(createTestConfiguration()).use_before_send).toBe(false);
    });
  });

  describe('number_of_displays', () => {
    it('reports the display count available to the device', () => {
      displayCount = 3;

      expect(report(createTestConfiguration()).number_of_displays).toBe(3);
    });

    it('is omitted when init() runs before the app is ready', () => {
      appReady = false;

      expect(report(createTestConfiguration()).number_of_displays).toBeUndefined();
    });
  });

  it('reports the always-on main-process collectors', () => {
    const configuration = createTestConfiguration();

    expect(report(configuration)).toMatchObject({
      is_main_process: true,
      track_errors: true,
    });
  });
});
