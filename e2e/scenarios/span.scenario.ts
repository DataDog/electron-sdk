import { test, expect } from '../lib/helpers';
import type { TraceSamplingRule } from '@datadog/electron-sdk';
import type { MainPage } from '../lib/mainPage';

const ipcSpanCases: {
  title: string;
  trigger: (mainPage: MainPage) => Promise<unknown>;
  spanName: string;
  resource: string;
  spanKind: string;
}[] = [
  {
    title: 'electron.main.handle when ipcMain.handle listener is invoked',
    trigger: (mainPage) => mainPage.mainPing(),
    spanName: 'electron.main.handle',
    resource: 'ping',
    spanKind: 'consumer',
  },
  {
    title: 'electron.main.receive when ipcMain.on listener is invoked',
    trigger: (mainPage) => mainPage.mainFireAndForget(),
    spanName: 'electron.main.receive',
    resource: 'mainFireAndForget',
    spanKind: 'consumer',
  },
  {
    title: 'electron.main.send when webContents.send is called',
    trigger: (mainPage) => mainPage.triggerMainSend(),
    spanName: 'electron.main.send',
    resource: 'mainPush',
    spanKind: 'producer',
  },
];

for (const { title, trigger, spanName, resource, spanKind } of ipcSpanCases) {
  test(`emits an ${title} span with Electron context`, async ({ mainPage, intake }) => {
    await mainPage.flushTransport();
    const viewEvents = await intake.getEventsByType('view');
    const view = viewEvents[0].body;

    await trigger(mainPage);
    await mainPage.flushTransport();

    const span = await intake.waitForSpan((s) => s.name === spanName && s.resource === resource);
    expect(span.meta['span.kind']).toBe(spanKind);
    expect(span.meta['_dd.application.id']).toBe(view.application.id);
    expect(span.meta['_dd.session.id']).toBe(view.session.id);
    expect(span.meta['_dd.view.id']).toBe(view.view.id);
    expect(span.service).toBe('e2e-test-app');
  });
}

test('electron.main.send span is parented to the electron.main.handle span that triggers it', async ({
  mainPage,
  intake,
}) => {
  await mainPage.flushTransport();

  // triggerMainSend is an ipcMain.handle that calls webContents.send('mainPush') from inside
  // the handler, so the producer span must share the trace of the consumer handle span.
  await mainPage.triggerMainSend();
  await mainPage.flushTransport();

  const handleSpan = await intake.waitForSpan(
    (s) => s.name === 'electron.main.handle' && s.resource === 'triggerMainSend'
  );
  const sendSpan = await intake.waitForSpan((s) => s.name === 'electron.main.send' && s.resource === 'mainPush');

  expect(sendSpan.trace_id).toBe(handleSpan.trace_id);
  expect(sendSpan.parent_id).toBe(handleSpan.span_id);
});

const httpSpanCases: {
  description: string;
  invoke: (p: MainPage, url: string) => Promise<number>;
  ipcChannel: string;
}[] = [
  { description: 'fetch', invoke: (p, url) => p.mainFetch(url), ipcChannel: 'mainFetch' },
  { description: 'net.request', invoke: (p, url) => p.mainNetRequest(url), ipcChannel: 'mainNetRequest' },
  { description: 'net.fetch', invoke: (p, url) => p.mainNetFetch(url), ipcChannel: 'mainNetFetch' },
];

for (const { description, invoke, ipcChannel } of httpSpanCases) {
  test(`${description}: http span and IPC span share the same trace`, async ({ mainPage, intake, testServer }) => {
    await mainPage.flushTransport();

    const url = testServer.urlFor(200);
    const status = await invoke(mainPage, url);
    expect(status).toBe(200);
    await mainPage.flushTransport();

    const ipcSpan = await intake.waitForSpan((s) => s.name === 'electron.main.handle' && s.resource === ipcChannel);

    const httpSpan = await intake.waitForSpan((s) => s.name === 'http.request' && s.trace_id === ipcSpan.trace_id);
    expect(httpSpan.parent_id).toBe(ipcSpan.span_id);
  });
}

test.describe('trace sampling rules', () => {
  test.use({
    sdkConfigOverrides: {
      traceSamplingRules: [
        { name: 'electron.main.handle', resource: 'mainNetRequest', sampleRate: 0 },
        { name: 'electron.main.handle', resource: 'mainNetRequest', sampleRate: 100 },
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
      predicate: (event) => event.body.resource.url === url,
    });
    const resource = received.body;
    expect(resource._dd.trace_id).toBeDefined();
    expect(resource._dd.span_id).toBeDefined();
    expect(testServer.headersFor(201)['x-datadog-trace-id']).toBeDefined();
    await intake.waitForSpan((span) => span.name === 'electron.main.handle' && span.resource === 'mainNetFetch');
  });
});

const traceSamplingRuleCases: { description: string; rule: TraceSamplingRule }[] = [
  { description: 'name', rule: { name: 'electron.main.handle', sampleRate: 0 } },
  { description: 'resource', rule: { resource: 'mainNetRequest', sampleRate: 0 } },
  { description: 'tags', rule: { tags: { component: 'electron', 'span.kind': 'consumer' }, sampleRate: 0 } },
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
      expect(
        intake.getSpans(
          (span) =>
            (span.name === 'electron.main.handle' && span.resource === 'mainNetRequest') ||
            (span.name === 'http.request' && span.meta['http.url'] === url)
        )
      ).toHaveLength(0);
    });
  });
}
