import type { RumResourceEvent } from '@datadog/electron-sdk';
import { expect, test } from '../lib/helpers';

test.use({
  sdkConfigOverrides: {
    traceSamplingRules: [{ name: 'electron.main.handle', resource: 'mainNetRequest', sampleRate: 0 }],
  },
});

test('drops a matching trace and keeps its RUM resource unlinked', async ({ intake, mainPage, testServer }) => {
  const url = testServer.urlFor(200);

  await mainPage.mainNetRequest(url);
  await mainPage.flushTransport();

  const [received] = await intake.waitForEventCount('resource', 1, {
    predicate: (event) => (event.body as RumResourceEvent).resource.url === url,
  });
  const resource = received.body as RumResourceEvent;
  expect(resource._dd.trace_id).toBeUndefined();
  expect(resource._dd.span_id).toBeUndefined();
  expect(
    intake.getSpans(
      (span) =>
        (span.name === 'electron.main.handle' && span.resource === 'mainNetRequest') ||
        (span.name === 'http.request' && span.meta['http.url'] === url)
    )
  ).toHaveLength(0);
});

test('keeps traces that do not match a rule', async ({ intake, mainPage, testServer }) => {
  const url = testServer.urlFor(201);

  await mainPage.mainNetFetch(url);
  await mainPage.flushTransport();

  const [received] = await intake.waitForEventCount('resource', 1, {
    predicate: (event) => (event.body as RumResourceEvent).resource.url === url,
  });
  const resource = received.body as RumResourceEvent;
  expect(resource._dd.trace_id).toBeDefined();
  expect(resource._dd.span_id).toBeDefined();
  await intake.waitForSpan((span) => span.name === 'electron.main.handle' && span.resource === 'mainNetFetch');
});
