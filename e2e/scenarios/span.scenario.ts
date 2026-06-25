import { test, expect } from '../lib/helpers';
import type { RumViewEvent } from '@datadog/electron-sdk';

test('emits an IPC span with Electron context', async ({ mainPage, intake }) => {
  await mainPage.flushTransport();
  const viewEvents = await intake.getEventsByType('view');
  const view = viewEvents[0].body as RumViewEvent;

  await mainPage.mainPing();
  await mainPage.flushTransport();

  const span = await intake.waitForSpan((span) => span.name === 'electron.main.handle' && span.resource === 'ping');
  expect(span.meta['_dd.application.id']).toBe(view.application.id);
  expect(span.meta['_dd.session.id']).toBe(view.session.id);
  expect(span.meta['_dd.view.id']).toBe(view.view.id);
  expect(span.service).toBe('e2e-test-app');
});

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

test('emits an http.request span for net.fetch calls', async ({ mainPage, intake, testServer }) => {
  await mainPage.flushTransport();

  const url = testServer.urlFor(200);
  const status = await mainPage.mainNetFetch(url);
  expect(status).toBe(200);

  await mainPage.flushTransport();

  const span = await intake.waitForSpan(
    (s) => s.name === 'http.request' && s.meta['http.url']?.includes('/status/200')
  );
  expect(span.meta['http.method']).toBe('GET');
  expect(span.meta['component']).toBe('electron');
});
