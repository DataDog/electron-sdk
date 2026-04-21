import { datadogRum } from '@datadog/browser-rum';

datadogRum.init({
  applicationId: 'e2e-renderer-app-id',
  clientToken: 'pub-renderer-token',
  site: 'datadoghq.com',
  service: 'e2e-renderer',
  sessionSampleRate: 100,
  trackResources: true,
  trackLongTasks: true,
  trackUserInteractions: true,
});

document.getElementById('status')!.textContent = 'bridge-ready';
