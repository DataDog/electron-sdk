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

document.getElementById('status')!.textContent = 'bridge-ready';
