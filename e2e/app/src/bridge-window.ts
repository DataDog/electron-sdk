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
});

// Lets a test set the renderer's own global context, so the merge with the main-process one
// can be asserted end to end.
type RendererGlobalContext = Parameters<typeof datadogRum.setGlobalContext>[0];
(window as unknown as Record<string, unknown>).setRendererGlobalContext = (context: RendererGlobalContext) =>
  datadogRum.setGlobalContext(context);

document.getElementById('status')!.textContent = 'bridge-ready';
