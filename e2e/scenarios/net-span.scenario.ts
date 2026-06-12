import { test, expect } from '../lib/helpers';

test('emits an http.request span for net.request calls', async ({ mainPage, intake, testServer }) => {
  await mainPage.flushTransport();

  const url = testServer.urlFor(200);
  const status = await mainPage.mainNetRequest(url);
  expect(status).toBe(200);

  await mainPage.flushTransport();

  const span = await intake.waitForSpan(
    (s) => s.name === 'http.request' && s.meta['http.url']?.includes('/status/200')
  );
  expect(span.meta['http.method']).toBe('GET');
  expect(span.meta['http.status_code']).toBeDefined();
  expect(span.meta['component']).toBe('electron');
});
