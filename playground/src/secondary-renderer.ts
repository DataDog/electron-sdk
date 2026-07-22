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

function setStatus(msg: string) {
  status.textContent = msg;
}

const fetchBtn = document.getElementById('fetch-btn') as HTMLButtonElement;
fetchBtn.addEventListener('click', () => {
  fetchBtn.disabled = true;
  setStatus('Fetching…');
  fetch('https://httpbin.org/json')
    .then((res) => res.json())
    .then(() => setStatus('Fetch done'))
    .catch((err) => setStatus(`Fetch error: ${String(err)}`))
    .finally(() => {
      fetchBtn.disabled = false;
    });
});

const errorBtn = document.getElementById('error-btn') as HTMLButtonElement;
errorBtn.addEventListener('click', () => {
  setStatus('Error thrown');
  throw new Error('test error from secondary renderer');
});
