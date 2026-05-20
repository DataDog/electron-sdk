import { test, expect } from '../lib/helpers';
import type { RumResourceEvent, RumViewEvent } from '@datadog/electron-sdk';

test('emits a resource event for a main-process fetch', async ({ mainPage, intake, testServer }) => {
  await mainPage.flushTransport();
  const viewEvents = await intake.getEventsByType('view');
  const view = viewEvents[0].body as RumViewEvent;

  const url = testServer.urlFor(200);
  await mainPage.mainFetch(url);
  await mainPage.flushTransport();

  const resourceEvents = await intake.getEventsByType('resource');
  expect(resourceEvents).toHaveLength(1);

  const resource = resourceEvents[0].body as RumResourceEvent;
  expect(resource.resource.method).toBe('GET');
  expect(resource.resource.status_code).toBe(200);
  expect(resource.resource.url).toBe(url);
  expect(resource.application.id).toBe(view.application.id);
  expect(resource.session.id).toBe(view.session.id);
  expect(resource.view.id).toBe(view.view.id);
  expect(resource._dd.trace_id).toBeDefined();
  expect(resource._dd.span_id).toBeDefined();
});

test('emits a resource event for a main-process http.request', async ({ mainPage, intake, testServer }) => {
  await mainPage.flushTransport();
  const viewEvents = await intake.getEventsByType('view');
  const view = viewEvents[0].body as RumViewEvent;

  const url = testServer.urlFor(404);
  await mainPage.mainHttpRequest(url);
  await mainPage.flushTransport();

  const resourceEvents = await intake.getEventsByType('resource');
  expect(resourceEvents).toHaveLength(1);

  const resource = resourceEvents[0].body as RumResourceEvent;
  expect(resource.resource.method).toBe('GET');
  expect(resource.resource.status_code).toBe(404);
  expect(resource.resource.url).toBe(url);
  expect(resource.application.id).toBe(view.application.id);
  expect(resource.session.id).toBe(view.session.id);
  expect(resource.view.id).toBe(view.view.id);
  expect(resource._dd.trace_id).toBeDefined();
  expect(resource._dd.span_id).toBeDefined();
});

test('emits a resource event for a main-process net.request', async ({ mainPage, intake, testServer }) => {
  await mainPage.flushTransport();
  const viewEvents = await intake.getEventsByType('view');
  const view = viewEvents[0].body as RumViewEvent;

  const url = testServer.urlFor(500);
  await mainPage.mainNetRequest(url);
  await mainPage.flushTransport();

  const resourceEvents = await intake.getEventsByType('resource');
  expect(resourceEvents).toHaveLength(1);

  const resource = resourceEvents[0].body as RumResourceEvent;
  expect(resource.resource.method).toBe('GET');
  expect(resource.resource.status_code).toBe(500);
  expect(resource.resource.url).toBe(url);
  expect(resource.application.id).toBe(view.application.id);
  expect(resource.session.id).toBe(view.session.id);
  expect(resource.view.id).toBe(view.view.id);
  expect(resource._dd.trace_id).toBeDefined();
  expect(resource._dd.span_id).toBeDefined();
});

test('does not emit a resource event for SDK intake traffic', async ({ mainPage, intake }) => {
  await mainPage.flushTransport();
  await intake.getEventsByType('view');

  const intakeUrl = `http://localhost:${intake.getPort()}/api/v2/rum`;
  await mainPage.mainHttpRequest(intakeUrl);
  await mainPage.flushTransport();

  await intake.assertNoNewEvents('resource');
});
