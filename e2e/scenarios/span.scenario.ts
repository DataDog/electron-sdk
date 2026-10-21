import { test, expect } from '../lib/helpers';
import type { TraceSamplingRule } from '@datadog/electron-sdk';
import type { MainPage } from '../lib/mainPage';

const httpSpanCases: {
  description: string;
  invoke: (p: MainPage, url: string) => Promise<number>;
}[] = [
  { description: 'fetch', invoke: (p, url) => p.mainFetch(url) },
  { description: 'net.request', invoke: (p, url) => p.mainNetRequest(url) },
  { description: 'net.fetch', invoke: (p, url) => p.mainNetFetch(url) },
];

for (const { description, invoke } of httpSpanCases) {
  test(`${description}: emits a root http span with Electron context`, async ({ mainPage, intake, testServer }) => {
    await mainPage.flushTransport();
    const viewEvents = await intake.getEventsByType('view');
    const view = viewEvents[0].body;

    const url = testServer.urlFor(200);
    const status = await invoke(mainPage, url);
    expect(status).toBe(200);
    await mainPage.flushTransport();

    // Global fetch may also yield nested http.request spans for the same URL, so wait for the root one.
    const span = await intake.waitForSpan(
      (s) => s.name === 'http.request' && s.meta['http.url'] === url && BigInt(`0x${s.parent_id}`) === 0n
    );
    expect(span.meta['_dd.application.id']).toBe(view.application.id);
    expect(span.meta['_dd.session.id']).toBe(view.session.id);
    expect(span.meta['_dd.view.id']).toBe(view.view.id);
    expect(span.service).toBe('e2e-test-app');
  });
}

test.describe('trace sampling rules', () => {
  test.use({
    sdkConfigOverrides: {
      traceSamplingRules: [
        { tags: { 'http.url': '*/status/200' }, sampleRate: 0 },
        { tags: { 'http.url': '*/status/200' }, sampleRate: 100 },
      ],
    },
  });

  test('uses the first matching rule and keeps the RUM resource unlinked', async ({ intake, mainPage, testServer }) => {
    const url = testServer.urlFor(200);

    await mainPage.mainNetRequest(url);
    await mainPage.flushTransport();

    const [received] = await intake.waitForEventCount('resource', 1, {
      predicate: (event) => event.body.resource.url === url,
    });
    const resource = received.body;
    expect(resource._dd.trace_id).toBeUndefined();
    expect(resource._dd.span_id).toBeUndefined();
    expect(testServer.headersFor(200)['x-datadog-trace-id']).toBeUndefined();
    expect(testServer.headersFor(200).traceparent).toBeUndefined();
    expect(intake.getSpans((span) => span.name === 'http.request' && span.meta['http.url'] === url)).toHaveLength(0);
  });

  test('keeps traces that do not match a rule', async ({ intake, mainPage, testServer }) => {
    const url = testServer.urlFor(201);

    await mainPage.mainNetFetch(url);
    await mainPage.flushTransport();

    const [received] = await intake.waitForEventCount('resource', 1, {
      predicate: (event) => event.body.resource.url === url,
    });
    const resource = received.body;
    expect(resource._dd.trace_id).toBeDefined();
    expect(resource._dd.span_id).toBeDefined();
    expect(testServer.headersFor(201)['x-datadog-trace-id']).toBeDefined();
    await intake.waitForSpan((span) => span.name === 'http.request' && span.meta['http.url'] === url);
  });
});

test.describe('trace sample rate fallback', () => {
  test.use({
    sdkConfigOverrides: {
      traceSampleRate: 0,
      traceSamplingRules: [{ tags: { 'http.url': '*/status/202' }, sampleRate: 100 }],
    },
  });

  test('uses a matching rule before the fallback sample rate', async ({ intake, mainPage, testServer }) => {
    const url = testServer.urlFor(202);

    await mainPage.mainNetRequest(url);
    await mainPage.flushTransport();

    const [received] = await intake.waitForEventCount('resource', 1, {
      predicate: (event) => event.body.resource.url === url,
    });
    expect(received.body._dd.trace_id).toBeDefined();
    expect(received.body._dd.span_id).toBeDefined();
    expect(testServer.headersFor(202)['x-datadog-trace-id']).toBeDefined();
    await intake.waitForSpan((span) => span.name === 'http.request' && span.meta['http.url'] === url);
  });

  test('uses the fallback sample rate when no rule matches', async ({ intake, mainPage, testServer }) => {
    const url = testServer.urlFor(203);

    await mainPage.mainNetFetch(url);
    await mainPage.flushTransport();

    const [received] = await intake.waitForEventCount('resource', 1, {
      predicate: (event) => event.body.resource.url === url,
    });
    expect(received.body._dd.trace_id).toBeUndefined();
    expect(received.body._dd.span_id).toBeUndefined();
    expect(testServer.headersFor(203)['x-datadog-trace-id']).toBeUndefined();
    expect(testServer.headersFor(203).traceparent).toBeUndefined();
    expect(intake.getSpans((span) => span.name === 'http.request' && span.meta['http.url'] === url)).toHaveLength(0);
  });
});

test.describe('RUM session sampling', () => {
  test.use({ sdkConfigOverrides: { sessionSampleRate: 0, traceSampleRate: 100 } });

  test('does not propagate trace context for an unsampled session', async ({ intake, mainPage, testServer }) => {
    const url = testServer.urlFor(204);

    await mainPage.mainNetRequest(url);
    await mainPage.flushTransport();

    expect(testServer.headersFor(204)['x-datadog-trace-id']).toBeUndefined();
    expect(testServer.headersFor(204).traceparent).toBeUndefined();
    expect(intake.getSpans((span) => span.name === 'http.request' && span.meta['http.url'] === url)).toHaveLength(0);
  });

  test('does not propagate trace context through dd-trace HTTP integrations', async ({ mainPage, testServer }) => {
    await mainPage.mainFetch(testServer.urlFor(205));
    await mainPage.mainHttpRequest(testServer.urlFor(206));

    expect(testServer.headersFor(205)['x-datadog-trace-id']).toBeUndefined();
    expect(testServer.headersFor(205).traceparent).toBeUndefined();
    expect(testServer.headersFor(206)['x-datadog-trace-id']).toBeUndefined();
    expect(testServer.headersFor(206).traceparent).toBeUndefined();
  });
});

const traceSamplingRuleCases: { description: string; rule: TraceSamplingRule }[] = [
  { description: 'name', rule: { name: 'http.request', sampleRate: 0 } },
  { description: 'resource', rule: { resource: 'GET', sampleRate: 0 } },
  { description: 'tags', rule: { tags: { 'http.url': '*/status/200' }, sampleRate: 0 } },
];

for (const { description, rule } of traceSamplingRuleCases) {
  test.describe(`${description} trace sampling rule`, () => {
    test.use({ sdkConfigOverrides: { traceSamplingRules: [rule] } });

    test('drops a matching trace', async ({ intake, mainPage, testServer }) => {
      const url = testServer.urlFor(200);

      await mainPage.mainNetRequest(url);
      await mainPage.flushTransport();

      await intake.waitForEventCount('resource', 1, {
        predicate: (event) => event.body.resource.url === url,
      });
      expect(intake.getSpans((span) => span.name === 'http.request' && span.meta['http.url'] === url)).toHaveLength(0);
    });
  });
}
