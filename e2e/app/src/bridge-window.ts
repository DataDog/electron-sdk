import { datadogLogs } from '@datadog/browser-logs';
import { datadogRum } from '@datadog/browser-rum';

datadogRum.init({
  applicationId: 'e2e-renderer-app-id',
  clientToken: 'pub-renderer-token',
  site: 'datadoghq.com',
  service: 'e2e-renderer',
  trackResources: true,
  trackLongTasks: true,
  trackUserInteractions: true,
  profilingSampleRate: 100,
  sessionReplaySampleRate: 100,
  telemetrySampleRate: 100,
  telemetryConfigurationSampleRate: 100,
  telemetryUsageSampleRate: 100,
});

// The Logs SDK detects the same bridge the RUM SDK does, so every log it collects is routed over
// IPC instead of to intake. Its sessionSampleRate is not applied in bridge mode; the Electron SDK's
// logsSampleRate is authoritative, matching the Android and iOS WebView integrations.
datadogLogs.init({
  clientToken: 'pub-renderer-token',
  site: 'datadoghq.com',
  service: 'e2e-renderer',
  env: 'e2e',
  version: '1.0.0',
  sessionSampleRate: 100,
  forwardErrorsToLogs: true,
});

document.getElementById('status')!.textContent = 'bridge-ready';
