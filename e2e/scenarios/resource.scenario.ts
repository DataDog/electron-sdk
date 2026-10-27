import { test, expect } from '../lib/helpers';
import type { RumResourceEvent } from '@datadog/electron-sdk';
import { isMainProcessEvent, Span } from '../lib/intake';
import { SLOW_RESPONSE_DELAY_MS } from '../lib/testServer';

function matchResourceTraceId(resource: RumResourceEvent) {
  return (span: Span) => BigInt(`0x${span.trace_id}`) === BigInt(resource._dd.trace_id!);
}

test('emits a resource event for a main-process fetch', async ({ mainPage, intake, testServer }) => {
  await mainPage.flushTransport();
  const [{ body: mainContext }] = await intake.getEventsByType('execution_context', { predicate: isMainProcessEvent });

  const url = testServer.urlFor(200);
  await mainPage.mainFetch(url);
  await mainPage.flushTransport();

  const resourceEvents = await intake.getEventsByType('resource');
  expect(resourceEvents).toHaveLength(1);

  const resource = resourceEvents[0].body;
  expect(resource.resource.method).toBe('GET');
  expect(resource.resource.status_code).toBe(200);
  expect(resource.resource.url).toBe(url);
  expect(resource.application.id).toBe(mainContext.application.id);
  expect(resource.session.id).toBe(mainContext.session.id);
  expect(resource.execution_context).toMatchObject({ id: mainContext.execution_context.id, type: 'main-process' });
  expect(resource._dd.trace_id).toBeDefined();
  expect(resource._dd.span_id).toBeDefined();

  const span = await intake.waitForSpan(matchResourceTraceId(resource));
  expect(span.meta['_dd.application.id']).toBe(mainContext.application.id);
  expect(span.meta['_dd.session.id']).toBe(mainContext.session.id);
  expect(span.meta['_dd.execution_context.id']).toBe(mainContext.execution_context.id);
  expect(span.service).toBe('e2e-test-app');
});

test('emits a resource event for a main-process http.request', async ({ mainPage, intake, testServer }) => {
  await mainPage.flushTransport();
  const [{ body: mainContext }] = await intake.getEventsByType('execution_context', { predicate: isMainProcessEvent });

  const url = testServer.urlFor(404);
  await mainPage.mainHttpRequest(url);
  await mainPage.flushTransport();

  const resourceEvents = await intake.getEventsByType('resource');
  expect(resourceEvents).toHaveLength(1);

  const resource = resourceEvents[0].body;
  expect(resource.resource.method).toBe('GET');
  expect(resource.resource.status_code).toBe(404);
  expect(resource.resource.url).toBe(url);
  expect(resource.application.id).toBe(mainContext.application.id);
  expect(resource.session.id).toBe(mainContext.session.id);
  expect(resource.execution_context).toMatchObject({ id: mainContext.execution_context.id, type: 'main-process' });
  expect(resource._dd.trace_id).toBeDefined();
  expect(resource._dd.span_id).toBeDefined();

  const span = await intake.waitForSpan(matchResourceTraceId(resource));
  expect(span.meta['_dd.application.id']).toBe(mainContext.application.id);
  expect(span.meta['_dd.session.id']).toBe(mainContext.session.id);
  expect(span.meta['_dd.execution_context.id']).toBe(mainContext.execution_context.id);
  expect(span.service).toBe('e2e-test-app');
});

test('emits a resource event for a main-process net.request', async ({ mainPage, intake, testServer }) => {
  await mainPage.flushTransport();
  const [{ body: mainContext }] = await intake.getEventsByType('execution_context', { predicate: isMainProcessEvent });

  const url = testServer.urlFor(500);
  await mainPage.mainNetRequest(url);
  await mainPage.flushTransport();

  const resourceEvents = await intake.getEventsByType('resource');
  expect(resourceEvents).toHaveLength(1);

  const resource = resourceEvents[0].body;
  expect(resource.resource.method).toBe('GET');
  expect(resource.resource.status_code).toBe(500);
  expect(resource.resource.url).toBe(url);
  expect(resource.application.id).toBe(mainContext.application.id);
  expect(resource.session.id).toBe(mainContext.session.id);
  expect(resource.execution_context).toMatchObject({ id: mainContext.execution_context.id, type: 'main-process' });
  expect(resource._dd.trace_id).toBeDefined();
  expect(resource._dd.span_id).toBeDefined();

  const span = await intake.waitForSpan(matchResourceTraceId(resource));
  expect(span.meta['_dd.application.id']).toBe(mainContext.application.id);
  expect(span.meta['_dd.session.id']).toBe(mainContext.session.id);
  expect(span.meta['_dd.execution_context.id']).toBe(mainContext.execution_context.id);
  expect(span.service).toBe('e2e-test-app');
});

test('times a main-process net.request until its response headers', async ({ mainPage, intake, testServer }) => {
  await mainPage.flushTransport();
  await intake.getEventsByType('execution_context', { predicate: isMainProcessEvent });

  await mainPage.mainNetRequest(testServer.slowUrlFor(201));
  await mainPage.flushTransport();

  const resourceEvents = await intake.getEventsByType('resource');
  expect(resourceEvents).toHaveLength(1);

  const resource = resourceEvents[0].body;
  expect(resource.resource.status_code).toBe(201);
  expect(resource.resource.duration).toBeGreaterThanOrEqual(SLOW_RESPONSE_DELAY_MS * 1e6);

  const span = await intake.waitForSpan((span) => BigInt(`0x${span.span_id}`) === BigInt(resource._dd.span_id!));
  expect(span.meta['http.status_code']).toBe('201');
});

test('does not emit a resource event for SDK intake traffic', async ({ mainPage, intake }) => {
  await mainPage.flushTransport();
  await intake.getEventsByType('execution_context', { predicate: isMainProcessEvent });

  const intakeUrl = `http://localhost:${intake.getPort()}/api/v2/rum`;
  await mainPage.mainHttpRequest(intakeUrl);
  await mainPage.flushTransport();

  await intake.assertNoNewEvents('resource');
});
