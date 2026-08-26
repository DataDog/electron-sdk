import { datadogRum } from '@datadog/browser-rum';

datadogRum.init({
  applicationId: '6efd3722-af0a-4070-994c-0e87076d4814',
  clientToken: 'pub2a7307cdec74934cacb411a193f632f8',
  site: 'datad0g.com',
  service: 'electron-playground',
  env: 'dev',
  sessionSampleRate: 100,
  trackResources: true,
  trackLongTasks: true,
  trackUserInteractions: true,
});

const status = document.getElementById('status') as HTMLElement;

document.getElementById('fetch-btn')!.addEventListener('click', () => {
  status.textContent = 'Fetching…';
  fetch('https://httpbin.org/json')
    .then((res) => res.json())
    .then(() => (status.textContent = 'Fetch done'))
    .catch((err) => (status.textContent = `Fetch error: ${String(err)}`));
});

document.getElementById('error-btn')!.addEventListener('click', () => {
  status.textContent = 'Error thrown';
  throw new Error('test error from secondary renderer');
});
