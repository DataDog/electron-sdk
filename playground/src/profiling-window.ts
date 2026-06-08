import { datadogRum } from '@datadog/browser-rum';

datadogRum.init({
  applicationId: '6efd3722-af0a-4070-994c-0e87076d4814',
  clientToken: 'pub2a7307cdec74934cacb411a193f632f8',
  site: 'datad0g.com',
  service: 'electron-playground',
  env: 'dev',
  sessionSampleRate: 100,
  profilingSampleRate: 100,
  trackResources: true,
  trackLongTasks: true,
  trackUserInteractions: true,
});

const statusEl = document.getElementById('status')!;
statusEl.textContent = 'profiler started (profilingSampleRate: 100)';

document.getElementById('generate-long-task')?.addEventListener('click', () => {
  statusEl.textContent = 'generating long task…';
  setTimeout(() => {
    const start = Date.now();
    while (Date.now() - start < 500) {
      /* block to generate a measurable long task */
    }
    statusEl.textContent = 'long task done — close window to flush profiler';
  }, 0);
});
